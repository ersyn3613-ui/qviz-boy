// server.js — Between Us FFmpeg render server
// Canvas 900x1600, 30fps. Слои: fon (видео-фон, зациклен), 6 PNG-оверлеев,
// niz-pravo (PNG), audio (mp3). Все стили/тайминги/бокс берутся из payload
// с фолбэками на прежние хардкод-значения.

const express = require('express');
const multer = require('multer');
const { execFile } = require('child_process');
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');

const app = express();
const upload = multer({ dest: os.tmpdir() });

// ---- Константы канваса ----
const W = 900;
const H = 1600;
const FPS = 30;

// ---- Поля файлов, которые шлёт n8n (multipart) ----
// ВАЖНО: audio должен быть в списке, иначе multer отклонит запрос ("Unexpected field")
const FIELDS = [
  { name: 'fon', maxCount: 1 },
  { name: 'topleft', maxCount: 1 },
  { name: 'inscription', maxCount: 1 },
  { name: 'animal', maxCount: 1 },
  { name: 'item', maxCount: 1 },
  { name: 'transport', maxCount: 1 },
  { name: 'niz-pravo', maxCount: 1 },
  { name: 'audio', maxCount: 1 },
  { name: 'payload', maxCount: 1 }, // на случай, если payload прилетит как файл
];

function pick(files, name) {
  return files && files[name] && files[name][0] ? files[name][0].path : null;
}

function escapeDrawText(t) {
  // Экранирование для ffmpeg drawtext
  return String(t)
    .replace(/\\/g, '\\\\')
    .replace(/:/g, '\\:')
    .replace(/'/g, "\u2019") // заменяем апостроф на типографский, чтобы не ломать фильтр
    .replace(/%/g, '\\%');
}

// Простой перенос текста по ширине бокса (по количеству символов)
function wrapText(text, maxCharsPerLine) {
  const words = String(text).split(/\s+/);
  const lines = [];
  let line = '';
  for (const w of words) {
    const test = line ? line + ' ' + w : w;
    if (test.length > maxCharsPerLine && line) {
      lines.push(line);
      line = w;
    } else {
      line = test;
    }
  }
  if (line) lines.push(line);
  return lines;
}

app.get('/', (req, res) => res.send('OK'));

app.post('/render', upload.fields(FIELDS), (req, res) => {
  const files = req.files || {};
  const work = fs.mkdtempSync(path.join(os.tmpdir(), 'render-'));

  try {
    // ---- Разбор payload ----
    let payload = {};
    if (req.body && typeof req.body.payload === 'string') {
      try { payload = JSON.parse(req.body.payload); } catch (e) { payload = {}; }
    } else if (files.payload) {
      try { payload = JSON.parse(fs.readFileSync(files.payload[0].path, 'utf8')); } catch (e) { payload = {}; }
    }

    const question = payload.question || '';

    // Канвас (фолбэк на константы)
    const cw = (payload.canvas && payload.canvas.width) || W;
    const ch = (payload.canvas && payload.canvas.height) || H;

    // Длительность (фолбэк 13)
    const duration = Number(payload.duration || (payload.timings && payload.timings.duration) || 13);

    // Момент появления текста (фолбэк 3)
    const questionStart = Number((payload.timings && payload.timings.question_start) != null
      ? payload.timings.question_start
      : 3);

    // Бокс текста (фолбэк на прежние значения)
    const box = payload.box || {};
    const boxX = Number(box.x != null ? box.x : 128);
    const boxY = Number(box.y != null ? box.y : 253.26);
    const boxW = Number(box.width != null ? box.width : 644);

    // Стиль
    const style = payload.style || {};
    const fontSize = Number(style.fontSize || style.baseFontSize || 84);
    const lineSpacing = Number(style.lineSpacing || 1.5);
    const textColor = (style.textColor || '#4A3734').replace('#', '0x');

    // Аудио вкл/выкл
    const hasAudioFlag = payload.audio !== false && payload.mute !== true;

    // ---- Пути к входным файлам ----
    const fon = pick(files, 'fon');
    const layerNames = ['topleft', 'inscription', 'animal', 'item', 'transport', 'niz-pravo'];
    const layers = layerNames.map(n => ({ n, p: pick(files, n) })).filter(x => x.p);
    const audio = pick(files, 'audio');

    if (!fon) {
      return res.status(400).json({ error: 'Missing background (fon)' });
    }

    // ---- Шрифт ----
    const fontFile = fs.existsSync('/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf')
      ? '/usr/share/fonts/truetype/dejavu/DejaVuSans-Bold.ttf'
      : (fs.existsSync(path.join(__dirname, 'font.ttf')) ? path.join(__dirname, 'font.ttf') : null);

    // ---- Сборка ffmpeg args ----
    const inputs = [];
    // input 0: фон-видео (зациклен)
    inputs.push('-stream_loop', '-1', '-t', String(duration), '-i', fon);
    // остальные PNG-слои
    for (const l of layers) inputs.push('-i', l.p);
    // аудио (последний вход)
    let audioInputIndex = -1;
    if (audio) {
      audioInputIndex = 1 + layers.length; // после фона и слоёв
      inputs.push('-i', audio);
    }

    // filter_complex: масштабируем фон к канвасу, накладываем слои, рисуем текст
    let filter = `[0:v]scale=${cw}:${ch},setsar=1,fps=${FPS}[bg];`;
    let last = 'bg';
    layers.forEach((l, i) => {
      const inIdx = i + 1; // input index PNG
      const out = `v${i}`;
      filter += `[${last}][${inIdx}:v]overlay=0:0[${out}];`;
      last = out;
    });

    // Текст: перенос + позиционирование, появление на questionStart
    let textFilter = '';
    if (question && fontFile) {
      const approxCharW = fontSize * 0.5;
      const maxChars = Math.max(6, Math.floor(boxW / approxCharW));
      const lines = wrapText(question, maxChars);
      const lineH = fontSize * lineSpacing;
      const totalH = lineH * lines.length;
      let startY = boxY; // верх бокса

      lines.forEach((ln, i) => {
        const y = startY + i * lineH;
        const safe = escapeDrawText(ln);
        const draw = `drawtext=fontfile='${fontFile}':text='${safe}':` +
          `fontcolor=${textColor}:fontsize=${fontSize}:` +
          `x=(w-text_w)/2:y=${y}:` +
          `enable='gte(t,${questionStart})'`;
        textFilter += (textFilter ? ',' : '') + draw;
      });
    }

    const outLabel = 'vout';
    if (textFilter) {
      filter += `[${last}]${textFilter}[${outLabel}]`;
    } else {
      filter += `[${last}]null[${outLabel}]`;
    }

    const out = path.join(work, 'render.mp4');
    const args = [
      '-y',
      ...inputs,
      '-filter_complex', filter,
      '-map', `[${outLabel}]`,
    ];

    if (audio && hasAudioFlag) {
      args.push('-map', `${audioInputIndex}:a:0`);
      args.push('-c:a', 'aac', '-b:a', '192k', '-shortest');
    } else {
      args.push('-an');
    }

    args.push(
      '-t', String(duration),
      '-r', String(FPS),
      '-c:v', 'libx264',
      '-pix_fmt', 'yuv420p',
      '-profile:v', 'baseline',
      '-movflags', '+faststart',
      out
    );

    execFile('ffmpeg', args, { maxBuffer: 1024 * 1024 * 64 }, (err, stdout, stderr) => {
      if (err) {
        console.error('ffmpeg error:', stderr);
        cleanup(work, files);
        return res.status(500).json({ error: 'ffmpeg failed', detail: String(stderr).slice(-2000) });
      }
      res.setHeader('Content-Type', 'video/mp4');
      const stream = fs.createReadStream(out);
      stream.on('close', () => cleanup(work, files));
      stream.pipe(res);
    });
  } catch (e) {
    console.error(e);
    cleanup(work, files);
    res.status(500).json({ error: String(e.message || e) });
  }
});

function cleanup(work, files) {
  try { fs.rmSync(work, { recursive: true, force: true }); } catch (e) {}
  try {
    Object.values(files || {}).forEach(arr => arr.forEach(f => {
      try { fs.unlinkSync(f.path); } catch (e) {}
    }));
  } catch (e) {}
}

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log('Render server on ' + PORT));
