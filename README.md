# Meeting Copilot Mobile

A phone version of the desktop Meeting Copilot idea. It listens through the phone's microphone and writes what to say back, using your own Gemini API key. It is a web app (PWA): no store, no build step.

## Put it online (needs HTTPS, or the microphone will not work)

**GitHub Pages (works from a phone browser)**
1. Create a new public repository on github.com.
2. Add file, Upload files, and upload everything in this folder (not the folder itself).
3. Settings, Pages, Deploy from a branch, `main` and `/ (root)`, Save.
4. After a minute the app is at `https://YOUR-NAME.github.io/REPO-NAME/`.

**Netlify Drop (from a computer):** open app.netlify.com/drop and drag this folder in.

## Install on Android

Open the link in Chrome, then menu, **Install app** (or **Add to Home screen**). It opens full screen like an app.

## First use

1. **Settings**: paste your Gemini key (free at aistudio.google.com), press **Test key**, and pick a model from the list if the default is not there.
2. **Brief**: who you are meeting, your goal, your prices and lines. Use `NOTE - DON'T SAY` for private reminders.
3. **Live**: press **Start listening**. Set **Me** before you speak, **Them** after.

## What works and what does not

- The phone's microphone must hear the other person: in-person meetings, or a call playing on another device near the phone.
- If the call is on this same phone, Android often gives the microphone to the call app and this page may hear nothing. A web page cannot record a call's audio.
- Keep the screen on and the page open. Chrome on Android is the supported browser.
- Chrome sends the microphone audio to Google's speech service while you listen.

## Files

- `index.html`, `style.css`, `app.js`: the interface
- `logic.js`: answer rules, prompt, stream parsing (ported from the desktop app)
- `sw.js`, `manifest.webmanifest`, `icon*`: install and offline shell
- `test.js`: `node --test test.js`

MIT licence, same as the desktop app.

## Credit

The answer rules and turn handling are ported from the MIT-licensed desktop app
[tanzeeldevAi/ai-meeting-assistant-copilot](https://github.com/tanzeeldevAi/ai-meeting-assistant-copilot).
