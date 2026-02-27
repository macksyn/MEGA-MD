const axios = require('axios');

// ─── CONFIG ────────────────────────────────────────────────────────────────────
const BASE = 'https://rynekoo-api.hf.space/video.gen/sora';
const POLL_INTERVAL_MS = 5000;  // check every 5s
const POLL_TIMEOUT_MS  = 300000; // give up after 5 minutes
// ───────────────────────────────────────────────────────────────────────────────

async function createVideo(prompt, ratio = '16:9') {
  const url = `${BASE}/create?prompt=${encodeURIComponent(prompt)}&ratio=${encodeURIComponent(ratio)}`;
  const { data } = await axios.get(url, {
    timeout: 30000,
    headers: { 'user-agent': 'Mozilla/5.0' },
  });

  if (!data?.success || !data?.result?.id) {
    throw new Error('Create failed: ' + JSON.stringify(data));
  }

  return data.result.id;
}

async function pollVideo(id) {
  const url = `${BASE}/get?id=${encodeURIComponent(id)}`;
  const start = Date.now();

  while (Date.now() - start < POLL_TIMEOUT_MS) {
    await new Promise((r) => setTimeout(r, POLL_INTERVAL_MS));

    const { data } = await axios.get(url, {
      timeout: 30000,
      headers: { 'user-agent': 'Mozilla/5.0' },
    });

    const result = data?.result;
    if (!result) throw new Error('Invalid poll response');

    if (result.status === 'succeeded') {
      if (!result.output) throw new Error('No output URL in succeeded response');
      return result.output;
    }

    if (result.status === 'failed') {
      throw new Error('Video generation failed on server side');
    }

    // statuses: "starting" | "processing" — keep polling
  }

  throw new Error('Timed out waiting for video');
}

module.exports = {
  command: 'sora',
  aliases: ['txt2video', 'aiVideo'],
  category: 'ai',
  description: 'Generate AI video from text using Sora',
  usage: '.sora <prompt> [--ratio 16:9|9:16|1:1]',

  async handler(sock, message, args, context) {
    const { chatId, channelInfo } = context;

    try {
      // Parse optional --ratio flag
      let ratio = '16:9';
      const ratioIndex = args.indexOf('--ratio');
      if (ratioIndex !== -1 && args[ratioIndex + 1]) {
        ratio = args[ratioIndex + 1];
        args.splice(ratioIndex, 2);
      }

      const quoted = message.message?.extendedTextMessage?.contextInfo?.quotedMessage;
      const quotedText = quoted?.conversation || quoted?.extendedTextMessage?.text || '';
      const input = args.join(' ') || quotedText;

      if (!input) {
        await sock.sendMessage(
          chatId,
          { text: '🎬 Provide a prompt.\n\nExample: `.sora A yellow ferrari speeding on a Nigerian road`', ...channelInfo },
          { quoted: message }
        );
        return;
      }

      await sock.sendMessage(
        chatId,
        { text: `⏳ Generating your Sora video...\n\n*Prompt:* ${input}\n*Ratio:* ${ratio}\n\nThis can take 1–3 minutes, please wait.`, ...channelInfo },
        { quoted: message }
      );

      const id = await createVideo(input, ratio);
      console.log(`[SORA] Job created: ${id}`);

      const videoUrl = await pollVideo(id);
      console.log(`[SORA] Done: ${videoUrl}`);

      await sock.sendMessage(
        chatId,
        {
          video: { url: videoUrl },
          mimetype: 'video/mp4',
          caption: `🎬 *Prompt:* ${input}`,
          ...channelInfo,
        },
        { quoted: message }
      );
    } catch (error) {
      console.error('[SORA] Error:', error?.message || error);
      await sock.sendMessage(
        chatId,
        { text: '❌ Failed to generate video. Try again later.', ...channelInfo },
        { quoted: message }
      );
    }
  },
};