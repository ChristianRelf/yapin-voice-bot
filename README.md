# yapin-voice-bot

A music bot for Yapin’ that joins a voice channel and plays YouTube audio, with a queue.

> **Before you run this.** Yapin’s own voice documentation says streaming from YouTube
> breaks their terms, and that Yapin’ turns off bots which play audio they don't have the
> rights to. This bot does exactly that, so the account running it is at risk. For a build
> that stays inside the rules, point `playQueue` at your own files, royalty-free or Creative
> Commons tracks, or a radio stream that permits it — `connection.play()` takes a file path
> or an http(s) URL, so only the `resolve`/`ytdlp` pair needs replacing.

## Requirements

- **Node 20+** (uses `--env-file-if-exists`, which needs 20.6+)
- **[yt-dlp](https://github.com/yt-dlp/yt-dlp)** on your PATH — resolves and downloads the audio
- **[ffmpeg](https://ffmpeg.org)** on your PATH — yapin.js decodes through it

Neither tool is currently installed on this machine. On Windows:

```powershell
winget install yt-dlp.yt-dlp
winget install Gyan.FFmpeg
```

Then open a new terminal so the PATH change takes effect, and check both:

```powershell
yt-dlp --version; ffmpeg -version
```

## Setup

```sh
npm install
```

Get a bot token from **Settings → Developer** in Yapin’ (it starts with `yb_`), then put it
in a `.env` file next to `bot.js`:

```
YAPIN_TOKEN=yb_your_token_here
```

Add the bot to your server, and give its role **Connect** and **Speak** on the voice
channels you want it in. Without Speak it joins muted and nobody hears it — the bot warns
you in chat when that happens.

## Run

```sh
npm start
```

## Commands

Each works as a `/` command or with your prefix.

| Command | What it does |
| --- | --- |
| `/play <link or search>` | Queue a video. Takes a YouTube link, a playlist link, or words to search for. |
| `/queue` | Show the current track and what's next. |
| `/nowplaying` (`/np`) | The current track, with a link. |
| `/skip` | Skip to the next track. |
| `/pause`, `/resume` | Pause and resume. |
| `/volume <0-200>` | Set the volume, as a percentage. 100 is normal. |
| `/stop` | Clear the queue and leave the channel. |

## How it works

`/play` runs `yt-dlp -J --flat-playlist` to get titles and durations without touching the
audio, so queueing stays fast and a playlist link expands into one entry per video.

Playback is per-server. The first `/play` joins the voice channel the author is sitting in
(`server.voice.connect`) and stores a queue keyed by server id. A loop then drains that
queue, spawning `yt-dlp -o -` per track and handing its stdout straight to
`connection.play()`, which resolves when the track finishes or `stop()` is called. Fetching
the audio at play time rather than at queue time means a stream URL can't expire while the
track waits its turn.

`/skip` and `/stop` both call `connection.stop()`; the difference is that `/stop` empties the
queue first, so the loop runs out and leaves on its own. When the queue empties or the
connection drops, the bot leaves and the yt-dlp child process is killed.

## Notes

- `yapin.js` itself has no dependencies. The ~30 packages in `node_modules` are all pulled
  in by `@livekit/rtc-node` (the native WebRTC bindings plus `pino` for logging), which
  yapin.js needs to connect to a call.
- The bot can be in one voice channel per server, and Yapin’ allows 10 voice joins/leaves
  per minute per bot.
- Set `YT_DLP` in the environment if yt-dlp isn't on your PATH under that name.
