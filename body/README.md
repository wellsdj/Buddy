# Buddy

A visual prototype for a circular, voice-first desk companion. It shows a live clock over rotating natural scenery and uses Chrome speech recognition to wake when you say “hey buddy,” display what it heard, and speak a placeholder response.

## Run it

Open `index.html` in a browser, or serve this directory with any static HTTP server. Backgrounds rotate every ten minutes. The response is intentionally local and random for this prototype; no AI key is used or stored.

## Next steps

- Add a secure server-side Claude API proxy (never put an API key in the browser).
- Connect a real wake-word / speech-to-text pipeline.
- Add skills and permissioned desktop actions.
