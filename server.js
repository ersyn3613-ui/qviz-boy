const express = require('express');
const multer = require('multer');
const { spawn } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');

const app = express();
const upload = multer({ dest: os.tmpdir() });

const FONT = '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf';

const W = 900;
const H = 1600;
const FPS = 30;

const BROWN = '0x5A3210';
const GREEN = '0x1E7A1E';
const BORDER = 'white';

const QUESTION_FONT = 40;
const HOOK_FONT = 40;
const ANSWER_FONT = 34;

// === РАСПОЛОЖЕНИЕ ТЕКСТА (по разметке) ===
const QUESTION_CY = 529;             // центр вопроса: 529,3 пкс от верха
const ANSWER_CY = [785, 890, 999,5];  // центры ответов: нижний опущен на 20px (991 -> 999,5)
const QUESTION_WRAP = 24;
const ANSWER_WRAP = 22;

app.get('/health', (req, res) => res.json({ ok: true }));

function esc(s) {
  return String(s == null ? '' : s)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, '\u2019')
    .replace(/%/g, '\\%')
    .replace(/\r?\n/g, ' ');
}

function wrap(text, maxChars) {
  const words = String(text == null ? '' : text).trim().split(/\s+/);
  const lines = [];
  let cur = '';
  for (const w of words) {
    if (!cur) { cur = w; continue; }
    if ((cur + ' ' + w).length <= maxChars) { cur += ' ' + w; }
    else { lines.push(cur); cur = w; }
  }
  if (cur) lines.push(cur);
  return lines.length ? lines : [''];
}

function drawtext({ text, fontsize, color, cy, enable }) {
  const lineH = Math.round(fontsize * 1.28);
  const lines = Array.isArray(text) ? text : [text];
  const n = lines.length;
  const startY = Math.round(cy - (n * lineH) / 2 + lineH / 2);
  return lines.map((ln, i) => {
    const y = startY + i * lineH - Math.round(fontsize / 2);
    return [
      'drawtext=fontfile=' + FONT,
      "text='" + esc(ln) + "'",
      'fontsize=' + fontsize,
      'fontcolor=' + color,
      'borderw=3',
      'bordercolor=' + BORDER,
      'x=(w-text_w)/2',
      'y=' + y,
      "enable='" + enable + "'",
    ].join(':');
  });
}

app.post(
  '/render',
  upload.fields([
    { name: 'fon', maxCount: 1 },
    { name: 'topleft', maxCount: 1 },
    { name: 'inscription', maxCount: 1 },
    { name: 'animal', maxCount: 1 },
    { name: 'item', maxCount: 1 },
    { name: 'transport', maxCount: 1 },
    { name: 'niz-pravo', maxCount: 1 },
  ]),
  (req, res) => {
    let payload = {};
    try { payload = JSON.parse(req.body.payload || '{}'); }
    catch (e) { return res.status(400).json({ error: 'BAD_PAYLOAD', detail: String(e) }); }

    const f = req.files || {};
    const need = ['fon', 'topleft', 'inscription', 'animal', 'item', 'transport', 'niz-pravo'];
    for (const k of need) {
      if (!f[k] || !f[k][0]) return res.status(400).json({ error: 'MISSING_FILE', field: k });
    }

    const t = payload.timings || {};
    const duration = Number(payload.duration) || Number(t.duration) || 13;
    const hookStart = Number(t.hook_start != null ? t.hook_start : 0);
    const questionStart = Number(t.question_start != null ? t.question_start : 3);
    const answerStart = Number(t.answer_start != null ? t.answer_start : 4);
    const answerStep = Number(t.answer_step != null ? t.answer_step : 0.3);
    const revealStart = Number(t.reveal_start != null ? t.reveal_start : 9);

    const question = payload.question || '';
    const hook = payload.hook || '';
    const answers = Array.isArray(payload.answers) ? payload.answers : [];
    const correctIndex = (Number(payload.correct_answer_position) || 1) - 1;

    const outPath = path.join(os.tmpdir(), 'out_' + Date.now() + '.mp4');

    const segs = [];
    segs.push('[0:v]scale=' + W + ':' + H + ',setsar=1,fps=' + FPS + '[b]');
    segs.push('[b][1:v]overlay=0:0[o1]');
    segs.push('[o1][2:v]overlay=0:0[o2]');
    segs.push('[o2][3:v]overlay=0:0[o3]');
    segs.push('[o3][4:v]overlay=0:0[o4]');
    segs.push('[o4][5:v]overlay=0:0[o5]');
    segs.push('[o5][6:v]overlay=0:0[o6]');

    const draws = [];

    if (hook) {
      draws.push(...drawtext({
        text: wrap(hook, QUESTION_WRAP),
        fontsize: HOOK_FONT, color: BROWN, cy: QUESTION_CY,
        enable: 'between(t,' + hookStart + ',' + questionStart + ')',
      }));
    }

    if (question) {
      draws.push(...drawtext({
        text: wrap(question, QUESTION_WRAP),
        fontsize: QUESTION_FONT, color: BROWN, cy: QUESTION_CY,
        enable: 'gte(t,' + questionStart + ')',
      }));
    }

    for (let i = 0; i < 3; i++) {
      const ans = answers[i];
      if (ans == null) continue;
      const appear = answerStart + i * answerStep;
      const cy = ANSWER_CY[i] != null ? ANSWER_CY[i] : (785 + i * 105);
      const wrapped = wrap(ans, ANSWER_WRAP);

      if (i === correctIndex) {
        draws.push(...drawtext({
          text: wrapped, fontsize: ANSWER_FONT, color: BROWN, cy,
          enable: 'between(t,' + appear + ',' + revealStart + ')',
        }));
        draws.push(...drawtext({
          text: wrapped, fontsize: ANSWER_FONT, color: GREEN, cy,
          enable: 'gte(t,' + revealStart + ')',
        }));
      } else {
        draws.push(...drawtext({
          text: wrapped, fontsize: ANSWER_FONT, color: BROWN, cy,
          enable: 'between(t,' + appear + ',' + revealStart + ')',
        }));
      }
    }

    let prev = 'o6';
    draws.forEach((d, idx) => {
      const out = 'd' + idx;
      segs.push('[' + prev + ']' + d + '[' + out + ']');
      prev = out;
    });
    if (draws.length === 0) {
      segs.push('[o6]null[vout]');
      prev = 'vout';
    } else {
      segs[segs.length - 1] = segs[segs.length - 1].replace('[' + prev + ']', '[vout]');
      prev = 'vout';
    }

    const filterComplex = segs.join(';');

    const args = [
      '-y',
      // fon теперь ВИДЕО (.mp4) — используем -stream_loop, а НЕ -loop
      '-stream_loop', '-1', '-i', f.fon[0].path,
      // остальные 6 слоёв — картинки (PNG), им нужен -loop 1
      '-loop', '1', '-i', f.topleft[0].path,
      '-loop', '1', '-i', f.inscription[0].path,
      '-loop', '1', '-i', f.animal[0].path,
      '-loop', '1', '-i', f.item[0].path,
      '-loop', '1', '-i', f.transport[0].path,
      '-loop', '1', '-i', f['niz-pravo'][0].path,
      '-filter_complex', filterComplex,
      '-map', '[vout]',
      '-map', '0:a?',            // ← звук из фонового видео (fon), необязательный
      '-t', String(duration),
      '-r', String(FPS),
      '-pix_fmt', 'yuv420p',
      '-c:v', 'libx264',
      '-preset', 'ultrafast',
      '-threads', '2',
      '-filter_complex_threads', '1',
      '-c:a', 'aac',             // ← аудиокодек
      '-b:a', '192k',
      '-shortest',               // ← обрезать по видео (зацикленный фон не тянет длину)
      '-movflags', '+faststart',
      outPath,
    ];

    const ff = spawn('ffmpeg', args);
    let stderr = '';
    ff.stderr.on('data', (d) => { stderr += d.toString(); });

    ff.on('close', (code) => {
      if (code !== 0 || !fs.existsSync(outPath)) {
        console.error('FFMPEG FAILED code=' + code);
        console.error(stderr);
        return res.status(500).json({ error: 'FFMPEG_FAILED', exitCode: code, stderr: stderr.slice(-4000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(outPath);
      stream.pipe(res);
      stream.on('close', () => { try { fs.unlinkSync(outPath); } catch (e) {} });
    });

    ff.on('error', (err) => {
      console.error('SPAWN ERROR', err);
      res.status(500).json({ error: 'SPAWN_ERROR', detail: String(err) });
    });
  }
);

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render server on ' + PORT));
