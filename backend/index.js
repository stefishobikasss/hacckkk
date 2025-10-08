// -----------------------------
// EASEACCESS Backend Server
// -----------------------------
const ffmpegPath = require('@ffmpeg-installer/ffmpeg').path;
const ffmpeg = require('fluent-ffmpeg');
ffmpeg.setFfmpegPath(ffmpegPath);
const express = require("express");
const bodyParser = require("body-parser");
const fs = require("fs");
const path = require("path");
const multer = require("multer");
const cors = require("cors");
const WebSocket = require("ws");
const { TextToSpeechClient } = require("@google-cloud/text-to-speech");
const speech = require("@google-cloud/speech");

// ---------- Setup ----------
const app = express();
const port = 3000;

app.use(cors());
app.use(bodyParser.json({ limit: "50mb" }));
app.use(express.static(path.join(__dirname, ".."))); // serve frontend

// ---------- File Upload Handling ----------
const upload = multer({ dest: path.join(__dirname, "uploads") });

// ---------- Google Cloud Setup ----------
const keyPath = path.join(__dirname, "key.json");
if (!fs.existsSync(keyPath)) {
  console.error("❌ Missing key.json in backend/");
  process.exit(1);
}

const credentials = JSON.parse(fs.readFileSync(keyPath, "utf8"));
const ttsClient = new TextToSpeechClient({ credentials });
const sttClient = new speech.SpeechClient({ credentials });

// ------------------------------------------------------
// 🗣️ TEXT TO SPEECH - Supports text OR uploaded file
// ------------------------------------------------------
app.post("/api/tts", upload.single("file"), async (req, res) => {
  try {
    let text = req.body.text;

    // --- If a file was uploaded, extract its contents ---
    if (!text && req.file) {
      const ext = path.extname(req.file.originalname).toLowerCase();
      const filePath = req.file.path;

      if (ext === ".txt") {
        text = fs.readFileSync(filePath, "utf8");
      } else if (ext === ".pdf") {
        // Use pdf-parse to extract text
        const pdf = require("pdf-parse");
        const dataBuffer = fs.readFileSync(filePath);
        const data = await pdf(dataBuffer);
        text = data.text;
      } else if (ext === ".docx") {
        // Use mammoth to extract text
        const mammoth = require("mammoth");
        const result = await mammoth.extractRawText({ path: filePath });
        text = result.value;
      } else {
        return res.status(400).send("Unsupported file type. Please upload .txt, .pdf, or .docx");
      }

      fs.unlinkSync(filePath); // cleanup uploaded file
    }

    if (!text || !text.trim()) {
      return res.status(400).send("No text found for TTS");
    }

    // --- Generate speech using Google TTS ---
    const [response] = await ttsClient.synthesizeSpeech({
      input: { text },
      voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
      audioConfig: { audioEncoding: "MP3" },
    });

    res.set("Content-Type", "audio/mpeg");
    res.send(response.audioContent);

  } catch (err) {
    console.error("TTS Error:", err);

    // --- Fallback: Return a spoken error message ---
    try {
      const [fallback] = await ttsClient.synthesizeSpeech({
        input: { text: "Sorry, text to speech failed. Please try again." },
        voice: { languageCode: "en-US", ssmlGender: "NEUTRAL" },
        audioConfig: { audioEncoding: "MP3" },
      });
      res.set("Content-Type", "audio/mpeg");
      res.send(fallback.audioContent);
    } catch {
      res.status(500).send("TTS failed completely.");
    }
  }
});

// ------------------------------------------------------
// 🎙️ FILE-BASED SPEECH-TO-TEXT (UPLOAD + TRANSCRIBE)
// ------------------------------------------------------
app.post("/api/transcribe", upload.single("file"), async (req, res) => {
  try {
    const filePath = req.file.path;
    const tmpWav = filePath + ".wav";

    // Convert any format → 16kHz WAV for Google Speech API
    await new Promise((resolve, reject) => {
      ffmpeg(filePath)
        .outputOptions(["-ar 16000", "-ac 1", "-f wav"])
        .save(tmpWav)
        .on("end", resolve)
        .on("error", reject);
    });

    const audioBytes = fs.readFileSync(tmpWav).toString("base64");

    const [response] = await sttClient.recognize({
      config: {
        encoding: "LINEAR16",
        sampleRateHertz: 16000,
        languageCode: "en-US",
        enableAutomaticPunctuation: true,
      },
      audio: { content: audioBytes },
    });

    fs.unlinkSync(filePath);
    fs.unlinkSync(tmpWav);

    const transcript = response.results.map(r => r.alternatives[0].transcript).join(" ");
    res.json({ transcript });
  } catch (err) {
    console.error("STT Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// ------------------------------------------------------
// 🌐 LIVE MICROPHONE STREAM (WebSocket)
// ------------------------------------------------------
const server = app.listen(port, () => {
  console.log(`🚀 Backend running on http://localhost:${port}`);
});

const wss = new WebSocket.Server({ server });

wss.on("connection", (ws) => {
  console.log("🎧 Client connected for live transcription");

  const request = {
    config: {
      encoding: "WEBM_OPUS",
      sampleRateHertz: 48000,
      languageCode: "en-US",
      enableAutomaticPunctuation: true,
    },
    interimResults: true,
  };

  const recognizeStream = sttClient.streamingRecognize(request)
    .on("error", (err) => {
      console.error("Speech API error:", err);
      ws.send(JSON.stringify({ error: "Speech recognition error" }));
    })
    .on("data", (data) => {
      if (data.results[0]?.alternatives[0]) {
        const transcript = data.results[0].alternatives[0].transcript;
        ws.send(JSON.stringify({ transcript }));
        console.log("🗣️", transcript);
      }
    });

  ws.on("message", (msg) => {
    recognizeStream.write(msg);
  });

  ws.on("close", () => {
    recognizeStream.end();
    console.log("❌ Client disconnected");
  });
});
