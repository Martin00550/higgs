# Omni Video

A local browser studio for Gemini Omni 1.2 Flash and Seedance 2.5 on OpenRouter. Requires Node.js 22 or later and an OpenRouter key with credits. The app uses Node’s built-in modules.

1. Keep your existing `.env` in this folder, or create it with `OPENROUTER_API_KEY=your-key`. You can also set the key in the environment before starting the app.
2. Double-click `Start Omni Video.cmd` or run `node server.mjs` in this folder.
3. The Windows launcher opens the app in your browser. If you started it from the terminal, open the URL it prints. Keep the launcher or terminal open while you use the app. The default is [port 8793](http://127.0.0.1:8793), and the app picks a free local port when 8793 is occupied.

## Workflows

- **Text to video** uses a prompt. Describe the subject, action, camera movement, and lighting.
- **Start / end frames** places an image at a specific point in the clip. Seedance uses a start image and an optional end image.
- **Reference to video** accepts image uploads or direct HTTPS image links. Seedance also accepts direct HTTPS audio and video links. Mention which details the model should take from each reference.
- **Edit a video** and **Extend a video** use a Seedance video reference and your instructions. Add a direct HTTPS link that OpenRouter can access. Specify what to change or what happens next while keeping the desired details of the source.

Local PNG, JPEG, and WebP uploads have a 10 MB total limit per request. Settings follow the selected model. The Seedance API guide advertises 480p, 720p, and 1080p. The provider can reject combinations of inputs and settings. The app displays its error when that happens.

The preview panel shows the final charge when OpenRouter reports it. The pre-generation estimate uses published rates for Gemini or Seedance at 480p and 720p. OpenRouter calculates the charge for auto duration, video references, and Seedance 1080p.

The most recent job can resume after a refresh in the same browser. Download the finished clip to keep a local copy. OpenRouter can expire jobs and their outputs.
