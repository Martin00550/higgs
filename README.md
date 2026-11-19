# Omni Video

A local browser studio for Gemini Omni 1.2 Flash and Seedance 2.5 on OpenRouter. Requires Node.js 22 or later and an OpenRouter key with credits. The app uses Node’s built-in modules.

1. Keep your existing `.env` in this folder, or create it with `OPENROUTER_API_KEY=your-key`. You can also set the key in the environment before starting the app.
2. Double-click `Start Omni Video.cmd` or run `node server.mjs` in this folder.
3. The Windows launcher opens the app in your browser. If you started it from the terminal, open the URL it prints. Keep the launcher or terminal open while you use the app. The default is [port 8793](http://127.0.0.1:8793), and the app picks a free local port when 8793 is occupied.

## Workflows

- **Text to video** uses a prompt. Describe the subject, action, camera movement, and lighting.
- **Start / end frames** places an image at a specific point in the clip. Seedance uses a start image and an optional end image.
- **Reference to video** accepts images and video on both models. Upload an MP4, or select **Video** under **Add media by link** and paste a direct HTTPS video URL that OpenRouter can access. Seedance also accepts HTTPS audio references. Mention which details the model should take from each reference.
- **Edit a video** and **Extend a video** take the source through the same video inputs. Specify what to change or what happens next while keeping the desired details of the source.

Local PNG, JPEG, WebP, and MP4 uploads have a combined 10 MB limit per request. The app sends uploads inline to OpenRouter when you generate. For a larger clip or if the provider rejects inline video, use a direct HTTPS video link. Settings follow the selected model. The Seedance API guide advertises 480p, 720p, and 1080p. The app displays any provider errors.

The preview panel shows the final charge when OpenRouter reports it. The pre-generation estimate uses published rates for Gemini or Seedance at 480p and 720p. OpenRouter calculates the charge for auto duration, video references, and Seedance 1080p.

Refreshing the same browser tab during submission reconnects to the local receipt while the server keeps running. Once OpenRouter returns a job ID, the browser remembers it across app restarts. If OpenRouter times out before returning an ID, check its activity before submitting again. Download finished clips to keep a local copy.
