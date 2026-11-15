/*
 * Meeting Copilot Mobile - pure logic (no DOM), so it can be unit-tested in Node.
 * Ported from the desktop app (src/main/brain.js, src/main/turnbuffer.js), MIT licence.
 */
(function (root, factory) {
  if (typeof module === 'object' && module.exports) module.exports = factory();
  else root.MC = factory();
})(typeof self !== 'undefined' ? self : this, function () {
  'use strict';

  const NEXT_MARK = '@@NEXT@@';

  const FILLER = new Set([
    'yeah', 'yes', 'yep', 'yup', 'no', 'nope', 'ok', 'okay', 'right', 'sure', 'cool', 'nice',
    'great', 'good', 'fine', 'mhm', 'mm', 'hmm', 'uh', 'um', 'uh huh', 'got it', 'i see',
    'thanks', 'thank you', 'alright', 'all right', 'exactly', 'true', 'indeed', 'perfect',
    'hello', 'hi', 'hey', 'bye', 'goodbye', 'see you', 'one moment', 'can you hear me',
    'you are on mute', "you're on mute",
  ]);

  const QUESTION_WORDS = /\b(what|how|why|when|where|which|who|whom|whose|can|could|would|will|do|does|did|is|are|was|were|have|has|should|shall|tell me|walk me|explain|describe|talk me through|any|do you)\b/i;

  // Words that mean the sentence is not finished yet.
  const DANGLING = /\b(and|but|so|or|because|that|then|the|a|an|to|of|for|with|from|in|on|at|if|when|while|which|who|like|about|into|over|as|is|are|was|were|be|been|have|has|had|will|would|can|could|should|my|our|your|their|its)[\s,]*$/i;

  const isEnglish = (lang) => !lang || /^en/i.test(lang);
  const wordCount = (t) => String(t || '').trim().split(/\s+/).filter(Boolean).length;

  /** Cheap gate before spending a request. Permissive: a missed answer is worse than an extra. */
  function needsAnswer(text, lang) {
    const t = String(text || '').trim();
    if (t.length < 3) return false;
    const hasQ = t.includes('?') || t.includes('؟');

    if (!isEnglish(lang)) {
      // No English word lists for other languages: use punctuation and length only.
      return hasQ || wordCount(t) >= 4;
    }

    const bare = t.toLowerCase().replace(/[^a-z\s']/g, '').trim();
    if (FILLER.has(bare)) return false;
    if (wordCount(bare) <= 3 && !hasQ) return false;
    if (hasQ) return true;
    if (QUESTION_WORDS.test(t)) return true;
    return wordCount(t) >= 8;
  }

  /** Does this look like a finished thought, or half of one? */
  function isSubstantive(text, lang) {
    const t = String(text || '').trim();
    if (!t) return false;
    if (isEnglish(lang) && DANGLING.test(t)) return false;
    if (t.includes('?') || t.includes('؟')) return true;
    const w = wordCount(t);
    if (w >= 8) return true;
    return w >= 3 && /[.!?۔؟]$/.test(t);
  }

  /**
   * Some Android Chrome versions return the whole phrase again as a new final result.
   * If the new final repeats or extends the previous one, keep only the new part.
   */
  function dedupeFinal(prev, next, gapMs) {
    const p = String(prev || '').trim();
    const n = String(next || '').trim();
    if (!n) return '';
    if (!p || (gapMs != null && gapMs > 2500)) return n;
    const pl = p.toLowerCase();
    const nl = n.toLowerCase();
    if (nl === pl) return '';
    if (nl.startsWith(pl) && p.length > 3) return n.slice(p.length).trim();
    return n;
  }

  const LANG_NAMES = {
    english: 'English',
    urdu: 'Urdu (in Urdu script)',
    roman: 'Roman Urdu (Urdu written in English letters)',
    hindi: 'Hindi',
    same: 'the same language the other person is speaking',
  };

  function buildSystem(brief, settings) {
    const b = brief || {};
    const s = settings || {};
    const maxWords = Number(s.maxWords) || 60;
    const lang = LANG_NAMES[s.answerLang] || LANG_NAMES.english;
    const L = [];

    L.push(
      'You are helping someone during a LIVE meeting. They are genuinely skilled at their work,',
      'but forming answers quickly under pressure is hard.',
      '',
      'You will be given what the OTHER person just said. You reply with the words YOUR PERSON',
      'should say back. They will read your reply out loud, more or less as written.',
      '',
      `LANGUAGE: write the reply in ${lang}.`,
      '',
      'HOW TO WRITE',
      '- First person, as them. Never "you could say" or "try telling them". Just the words.',
      `- Aim for 40-${maxWords} words: a real answer with substance, not a one-liner.`,
      '- Give the reasoning or the specifics that make it convincing, not just the conclusion.',
      '- Go SHORT (a sentence or two) only when the moment genuinely calls for it:',
      '  small talk, a yes/no, agreeing, or saying goodbye.',
      `- Never exceed ${maxWords + 40} words. They have to say this out loud.`,
      '- Plain, natural, spoken language. Everyday words. Short sentences.',
      '- Warm and human, not stiff or robotic. Contractions are good.',
      '- No bullet points, no headings, no markdown, no emoji. Just what they say.',
      '- No preamble. Start with the actual reply.',
      '',
      'THE FIRST SENTENCE IS THE ONE THAT MATTERS',
      '- My person starts reading the moment words appear, while you are still writing.',
      '  So the FIRST sentence must already answer the question directly and be safe to',
      '  say on its own. Put the answer first, the reasoning after.',
      '- Do not open with a wind-up: not "That is a great question", not "Absolutely",',
      '  not "So basically", not restating what they asked.',
      '',
      'THE PREPARED MATERIAL IS YOUR SCRIPT - WORK IN TWO MODES',
      '',
      'MODE 1 - a prepared line covers what they just said:',
      '- Use that line as close to WORD FOR WORD as you can.',
      '- Change only what the moment forces: a name, a connecting word, dropping a',
      '  sentence that no longer applies, joining two prepared lines that both fit.',
      '- Do NOT rewrite it in your own words. They chose that wording on purpose.',
      '- Prepared lines are usually marked "SAY", an arrow, a bullet or quotation marks.',
      '',
      'MODE 2 - they asked something the material does not cover:',
      '- Still answer it, but stay INSIDE the world of the prepared material.',
      '- Use only the facts, numbers, prices, services, claims and examples that appear',
      '  there. Match its voice, its vocabulary and its level of detail.',
      '- Never introduce a capability, price, promise or statistic that is not in it.',
      '- If the honest answer is not in the material, say you will confirm after the call.',
      '  Do not fill the gap with something plausible.',
      '',
      'The prepared material is the single source of truth for BOTH what to say and',
      'what is true. Treat anything outside it as something you do not know.',
      '- Once a prepared line has clearly been used, move on; do not repeat it later.',
      '',
      'PRIVATE NOTES - NEVER SAY THESE OUT LOUD',
      '- The brief may contain private reminders to my person: coaching, stage directions,',
      '  or anything marked "DO NOT SAY", "DON\'T SAY", "NOTE", "reminder", "private".',
      '- Those are instructions TO my person, never words FOR them. Never put them in your',
      '  reply. Use them to decide what to write, then write the spoken words only.',
      '',
      'NEVER CLAIM EXPERIENCE THAT IS NOT IN THE BRIEF',
      '- If they ask "have you done X / worked with Y / do you have results", only say yes',
      '  if the brief SAYS SO. Not if it is merely plausible. Not to be encouraging.',
      '- If the brief does not cover it, do NOT claim it and do NOT promise proof that may',
      '  not exist. Give an honest reply that still helps: say plainly what is new for you,',
      '  then show how you would approach it, or name what you HAVE done per the brief.',
      '- Never invent a case study, a past client, a metric, or a number of years.',
      '- Do not invent an EXCUSE either ("under NDA", "need to check with legal") unless',
      '  the brief says it.',
      '',
      'ACCURACY - THIS MATTERS MOST',
      '- Only state facts given in the brief, or that are genuinely general knowledge.',
      '- NEVER invent a number, date, price, budget, client name, feature or commitment.',
      '- If you give any figure, it must come from the brief. If they push for a price or a',
      '  budget that is not there, say you will send exact numbers after the call.',
      '- Check any arithmetic you write.',
      '- If they ask something only your person can answer (salary, availability), give a',
      '  natural, non-committal reply that keeps control with your person.',
      '',
      'IF NO REPLY IS NEEDED',
      '- If the other person was only acknowledging, joking, or making small talk that needs no',
      '  substantive answer, reply with exactly: ---',
      '',
      'AFTER THE REPLY',
      `- On a new line write exactly ${NEXT_MARK} and then up to three short questions my`,
      '  person could ask next to move the meeting toward their goal, one per line, no',
      '  numbering. Skip this part when the reply is ---.',
    );

    const has = (v) => v && String(v).trim();
    const ctx = [];
    if (has(b.title)) ctx.push(`Meeting: ${b.title}`);
    if (has(b.role)) ctx.push(`My person's role or position: ${b.role}`);
    if (has(b.otherSide)) ctx.push(`Who they are talking to: ${b.otherSide}`);
    if (has(b.goal)) ctx.push(`What a good outcome looks like: ${b.goal}`);
    if (has(b.background)) {
      ctx.push(
        'MY PERSON\'S PREPARED MATERIAL - their prepared lines, their facts, and their\n'
        + 'private notes. This is the FIRST place to look for what to say:\n' + b.background,
      );
    }
    const terms = Array.isArray(b.terms)
      ? b.terms
      : String(b.terms || '').split(',').map((x) => x.trim()).filter(Boolean);
    if (terms.length) ctx.push(`Names and jargon likely to come up: ${terms.join(', ')}`);

    L.push('', 'BRIEF FOR THIS MEETING');
    if (ctx.length) L.push(...ctx);
    else L.push('(none given - stay general and do not invent specifics)');

    return L.join('\n');
  }

  const who = (t) => (t.who === 'me' ? 'Me (my person)' : 'Them');

  /**
   * One stateless request: recent conversation + what they just said.
   * opts.typed  - my person typed this to the assistant instead of the other person speaking
   * opts.fresh  - write a different wording than before
   */
  function buildUserPrompt(question, history, previousAnswers, opts) {
    const o = opts || {};
    const P = [];
    if (history && history.length) {
      P.push('CONVERSATION SO FAR (most recent last):');
      for (const t of history) P.push(`${who(t)}: ${t.text}`);
      P.push('');
    }
    if (previousAnswers && previousAnswers.length) {
      P.push('LINES YOU ALREADY SUGGESTED EARLIER (do not repeat them):');
      for (const a of previousAnswers) P.push(`- ${a}`);
      P.push('');
    }
    if (o.typed) {
      P.push('MY PERSON TYPED THIS TO YOU (the other person did not say it):', question,
        '', 'Help them. If it is something to say out loud, write the spoken words.');
    } else {
      P.push('THE OTHER PERSON JUST SAID:', question, '', 'Write what my person should say back.');
    }
    if (o.fresh) P.push('', 'Give a fresh alternative wording, different from the previous reply.');
    return P.join('\n');
  }

  /** Split a (possibly still streaming) reply into spoken answer + next-question list. */
  function splitAnswer(raw) {
    let text = String(raw || '');
    let next = [];
    const i = text.indexOf(NEXT_MARK);
    if (i >= 0) {
      next = text.slice(i + NEXT_MARK.length)
        .split('\n').map((l) => l.replace(/^[\s\-*\d.)]+/, '').trim()).filter(Boolean).slice(0, 3);
      text = text.slice(0, i);
    } else {
      // Hide a half-arrived marker such as "@@NE" at the very end.
      for (let k = NEXT_MARK.length - 1; k >= 1; k--) {
        if (text.endsWith(NEXT_MARK.slice(0, k))) { text = text.slice(0, -k); break; }
      }
    }
    text = text.trim();
    const noReply = /^-{3}$/.test(text);
    const maybeNoReply = /^-{1,3}$/.test(text);
    return { answer: noReply || maybeNoReply ? '' : text, next, noReply };
  }

  /** Pull complete SSE events out of a growing buffer. Returns text pieces and the leftover. */
  function parseSSE(buffer) {
    const parts = String(buffer).split(/\r?\n\r?\n/);
    const rest = parts.pop();
    const texts = [];
    let error = null;
    for (const ev of parts) {
      for (const line of ev.split(/\r?\n/)) {
        if (!line.startsWith('data:')) continue;
        const payload = line.slice(5).trim();
        if (!payload || payload === '[DONE]') continue;
        try {
          const j = JSON.parse(payload);
          if (j.error) { error = j.error.message || 'request failed'; continue; }
          const c = j.candidates && j.candidates[0];
          const ps = c && c.content && c.content.parts;
          if (ps) texts.push(ps.map((p) => p.text || '').join(''));
          if (!ps && j.promptFeedback && j.promptFeedback.blockReason) {
            error = 'Blocked: ' + j.promptFeedback.blockReason;
          }
        } catch (e) { /* partial or non-JSON line: ignore */ }
      }
    }
    return { texts, rest, error };
  }

  /** Strip a ```json fence if the model added one, then parse. */
  function parseJSON(text) {
    const cleaned = String(text || '').replace(/^\s*```(?:json)?/i, '').replace(/```\s*$/, '').trim();
    try { return JSON.parse(cleaned); } catch (e) { /* fall through */ }
    const m = cleaned.match(/[[{][\s\S]*[\]}]/);
    if (m) { try { return JSON.parse(m[0]); } catch (e) { /* give up */ } }
    return null;
  }

  /** Friendly message for an API failure. */
  function explainError(status, message) {
    const m = String(message || '');
    if (status === 400 && /api key/i.test(m)) return 'The API key is not valid. Check it in Settings.';
    if (status === 401 || status === 403) return 'This key is not allowed to use that model. Check the key and model in Settings.';
    if (status === 404) return 'That model name was not found. Press "Test key" in Settings and pick a model from the list.';
    if (status === 429) return 'Limit reached (too many requests or the free quota is used up). Wait a minute or change the model.';
    if (status >= 500) return 'Gemini is having a problem right now. Try again in a moment.';
    return m || 'Request failed.';
  }

  return {
    NEXT_MARK, needsAnswer, isSubstantive, dedupeFinal, buildSystem, buildUserPrompt,
    splitAnswer, parseSSE, parseJSON, explainError, wordCount,
  };
});
