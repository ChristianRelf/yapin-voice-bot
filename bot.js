// A music bot that streams YouTube audio into Yapin’ voice channels, with a queue.
// Needs: npm install, plus yt-dlp and ffmpeg on your PATH.
//
// Yapin’s own voice docs say streaming from YouTube breaks their terms, and that
// bots playing audio they don't have the rights to get turned off. See README.md.
import { spawn } from 'node:child_process';
import { Client, Events } from 'yapin.js';

const YT_DLP = process.env.YT_DLP ?? 'yt-dlp';
// Opus-in-WebM pipes into ffmpeg cleanly; m4a stalls waiting for a moov atom.
const FORMAT = 'bestaudio[acodec=opus]/bestaudio[ext=webm]/bestaudio/best';
const MAX_QUEUE = 100;

const client = new Client({ commands: { help: true } });
const queues = new Map(); // server id → { connection, tracks: Track[], current: Track | null, child }

function clock(seconds) {
  if (typeof seconds !== 'number' || !Number.isFinite(seconds)) return 'live';
  const units = [Math.floor(seconds / 3600), Math.floor(seconds / 60) % 60, Math.floor(seconds % 60)];
  return (units[0] ? units : units.slice(1)).map((n, i) => (i ? String(n).padStart(2, '0') : n)).join(':');
}

// Spawns yt-dlp, keeping the tail of stderr so a failure can say why.
function ytdlp(args) {
  const child = spawn(YT_DLP, args, { stdio: ['ignore', 'pipe', 'pipe'] });
  let stderr = '';
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { stderr = (stderr + chunk).slice(-2000); });
  const why = (code) => new Error(stderr.trim().split('\n').filter(Boolean).pop()
    ?? (code === null ? 'yt-dlp stopped early.' : `yt-dlp exited with code ${code}.`));
  return { child, why };
}

const missing = (error) => error instanceof Error && 'code' in error && error.code === 'ENOENT';

// A link, a playlist, or plain words to search for → tracks, without fetching audio.
async function resolve(query) {
  const target = /^https?:\/\//i.test(query) ? query : `ytsearch1:${query}`;
  const { child, why } = ytdlp(['-J', '--flat-playlist', '--no-warnings', target]);
  let stdout = '';
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => { stdout += chunk; });

  const info = await new Promise((done, fail) => {
    child.once('error', (error) => fail(missing(error)
      ? new Error(`\`${YT_DLP}\` isn't on your PATH — install yt-dlp.`)
      : error));
    child.once('close', (code) => {
      if (code !== 0) return fail(why(code));
      try { done(JSON.parse(stdout)); } catch { fail(new Error("Couldn't read yt-dlp's output.")); }
    });
  });

  const entries = Array.isArray(info.entries) ? info.entries : [info];
  return entries.filter((entry) => entry?.id || entry?.url).map((entry) => ({
    title: entry.title ?? 'Unknown title',
    url: entry.webpage_url ?? entry.url ?? `https://www.youtube.com/watch?v=${entry.id}`,
    seconds: typeof entry.duration === 'number' ? entry.duration : null,
    by: entry.uploader ?? entry.channel ?? null,
  }));
}

// Drains the queue. The audio is fetched here, not at queue time, so a stream
// URL can't expire while the track waits its turn.
async function playQueue(serverId) {
  const queue = queues.get(serverId);

  while (queue && !queue.connection.destroyed && queue.tracks.length) {
    const track = queue.tracks[0];
    queue.current = track;
    const { child, why } = ytdlp(['-f', FORMAT, '--no-playlist', '--quiet', '--no-warnings', '-o', '-', track.url]);
    queue.child = child;
    try {
      await queue.connection.play(child.stdout);
      if (child.exitCode) throw why(child.exitCode);
    } catch (error) {
      client.logger.error(`Couldn't play ${track.title}:`, error.message);
    } finally {
      child.kill();
      queue.child = null;
    }
    queue.tracks.shift();
  }

  queues.delete(serverId);
  if (queue) {
    queue.current = null;
    await queue.connection.leave().catch(() => {});
  }
}

// The server's queue, joining the author's voice channel the first time.
async function joined(ctx) {
  const existing = queues.get(ctx.serverId);
  if (existing) return existing;

  const channelId = await ctx.server.voice.channelOf(ctx.authorId);
  if (!channelId) ctx.error('Join a voice channel first.');

  const queue = { connection: await ctx.server.voice.connect(channelId), tracks: [], current: null, child: null };
  queues.set(ctx.serverId, queue);
  queue.connection.on('error', (error) => client.logger.error('Voice error:', error.message));
  queue.connection.on('disconnect', () => {
    queue.tracks.length = 0;
    queue.child?.kill();
    queues.delete(ctx.serverId);
  });
  if (queue.connection.muted) await ctx.send('⚠️ I joined muted — nobody will hear me until I have Speak.');
  return queue;
}

client.commands.register({
  name: 'play',
  description: 'Play a YouTube video, by link or search',
  aliases: ['p'],
  serverOnly: true,
  examples: ['play never gonna give you up', 'play https://youtu.be/dQw4w9WgXcQ'],
  options: [{ name: 'query', description: 'A YouTube link or words to search for', rest: true, required: true }],
  async run(ctx) {
    let tracks;
    try {
      tracks = await resolve(ctx.values.query);
    } catch (error) {
      ctx.error(error.message);
    }
    if (!tracks.length) ctx.error(`Nothing found for "${ctx.values.query}".`);

    const queue = await joined(ctx);
    const added = tracks.slice(0, Math.max(0, MAX_QUEUE - queue.tracks.length));
    if (!added.length) ctx.error(`The queue is full (${MAX_QUEUE} tracks).`);
    queue.tracks.push(...added);

    const [first] = added;
    const more = added.length - 1;
    if (queue.tracks.length === added.length) {
      await ctx.reply(`▶️ Playing **${first.title}** (${clock(first.seconds)})${more ? ` — and ${more} more queued` : ''}`);
      playQueue(ctx.serverId);
    } else if (more) {
      await ctx.reply(`➕ Queued ${added.length} tracks, starting with **${first.title}**`);
    } else {
      await ctx.reply(`➕ Queued **${first.title}** (${clock(first.seconds)}) — #${queue.tracks.length}`);
    }
  },
});

client.command('skip', 'Skip the current track', (ctx) => {
  const queue = queues.get(ctx.serverId);
  if (!queue?.current) return ctx.reply('Nothing is playing.');
  queue.connection.stop(); // play() resolves, and the loop moves on
  return ctx.react('⏭️');
});

client.command('pause', 'Pause', (ctx) => { queues.get(ctx.serverId)?.connection.pause(); return ctx.react('⏸️'); });
client.command('resume', 'Resume', (ctx) => { queues.get(ctx.serverId)?.connection.resume(); return ctx.react('▶️'); });

client.command('stop', 'Stop, clear the queue and leave', (ctx) => {
  const queue = queues.get(ctx.serverId);
  if (!queue) return ctx.reply('Nothing is playing.');
  queue.tracks.length = 0;
  queue.connection.stop(); // the drained loop leaves on its own
  return ctx.react('⏹️');
});

client.command('queue', 'Show what is lined up', (ctx) => {
  const queue = queues.get(ctx.serverId);
  if (!queue?.tracks.length) return ctx.reply('The queue is empty.');
  const [current, ...rest] = queue.tracks;
  const lines = [`🎵 **Now playing:** ${current.title} (${clock(current.seconds)})`];
  if (rest.length) lines.push('', ...rest.slice(0, 10).map((t, i) => `${i + 1}. ${t.title} (${clock(t.seconds)})`));
  if (rest.length > 10) lines.push(`…and ${rest.length - 10} more`);
  return ctx.reply(lines.join('\n').slice(0, 2000));
});

client.commands.register({
  name: 'nowplaying',
  description: 'What is playing right now',
  aliases: ['np'],
  serverOnly: true,
  run(ctx) {
    const track = queues.get(ctx.serverId)?.current;
    if (!track) return ctx.reply('Nothing is playing.');
    return ctx.reply(`🎵 **${track.title}**${track.by ? ` — ${track.by}` : ''} (${clock(track.seconds)})\n${track.url}`);
  },
});

client.commands.register({
  name: 'volume',
  description: 'Set the volume, 0 to 200%',
  serverOnly: true,
  options: [{ name: 'percent', type: 'integer', min: 0, max: 200, required: true }],
  run(ctx) {
    const queue = queues.get(ctx.serverId);
    if (!queue) return ctx.reply('Nothing is playing.');
    queue.connection.setVolume(ctx.values.percent / 100);
    return ctx.reply(`🔊 ${ctx.values.percent}%`);
  },
});

client.on(Events.ClientReady, (ready) => client.logger.info(`${ready.user.displayName} is ready to play`));

for (const signal of ['SIGINT', 'SIGTERM']) {
  process.once(signal, async () => {
    for (const queue of queues.values()) queue.child?.kill();
    await client.voice.destroy().catch(() => {});
    process.exit(0);
  });
}

await client.login();
