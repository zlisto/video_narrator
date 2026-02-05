import React, { useState, useRef, useEffect } from 'react';
import OpenAI from 'openai';
import { FFmpeg } from '@ffmpeg/ffmpeg';
import { fetchFile, toBlobURL } from '@ffmpeg/util';
import './App.css';

function App() {
  const [activeTab, setActiveTab] = useState('narration');
  const [videoFile, setVideoFile] = useState(null);
  const [videoUrl, setVideoUrl] = useState(null);
  const [videoDuration, setVideoDuration] = useState(0);
  const [frames, setFrames] = useState([]);
  const [instructions, setInstructions] = useState('');
  const [narrationText, setNarrationText] = useState('');
  const [narrationAudioUrl, setNarrationAudioUrl] = useState(null);
  const [isExtractingFrames, setIsExtractingFrames] = useState(false);
  const [framesProgress, setFramesProgress] = useState('');
  const [isGeneratingText, setIsGeneratingText] = useState(false);
  const [isGeneratingAudio, setIsGeneratingAudio] = useState(false);
  const [isMerging, setIsMerging] = useState(false);
  const [narrationVolume, setNarrationVolume] = useState(50);
  const [videoVolume, setVideoVolume] = useState(50);
  const [mergedVideoUrl, setMergedVideoUrl] = useState(null);
  const [previewTime, setPreviewTime] = useState(0);
  const [previewDuration, setPreviewDuration] = useState(0);

  const videoRef = useRef(null);
  const narrationAudioRef = useRef(null);
  const mergedVideoRef = useRef(null);
  const timelineRef = useRef(null);
  const mixingNarrationRef = useRef(null);
  const mixContextRef = useRef(null);
  const videoGainRef = useRef(null);
  const narrationGainRef = useRef(null);
  const ffmpegRef = useRef(null);
  const [ffmpegLoaded, setFfmpegLoaded] = useState(false);

  const formatTime = (sec) => {
    const m = Math.floor(sec / 60);
    const s = Math.floor(sec % 60);
    const cs = Math.floor((sec % 1) * 100);
    return `${String(m).padStart(2, '0')}:${String(s).padStart(2, '0')}.${String(cs).padStart(2, '0')}`;
  };

  useEffect(() => {
    if (videoGainRef.current) videoGainRef.current.gain.value = videoVolume / 100;
    if (narrationGainRef.current) narrationGainRef.current.gain.value = narrationVolume / 100;
  }, [videoVolume, narrationVolume]);

  const seekAndPlay = (time) => {
    const duration = previewDuration || videoDuration || 0;
    const t = Math.max(0, Math.min(duration, time));

    if (mergedVideoUrl && mergedVideoRef.current) {
      mergedVideoRef.current.currentTime = t;
      mergedVideoRef.current.play();
      setPreviewTime(t);
      return;
    }

    const vidEl = videoRef.current;
    const narEl = mixingNarrationRef.current;
    if (!vidEl || !videoUrl) return;

    if (narrationAudioUrl && narEl) {
      const ctx = mixContextRef.current;
      if (!ctx) {
        const Ctx = window.AudioContext || window.webkitAudioContext;
        const audioContext = new Ctx();
        mixContextRef.current = audioContext;
        try {
          const stream = vidEl.captureStream();
          if (stream.getAudioTracks().length > 0) {
            const videoSource = audioContext.createMediaStreamSource(stream);
            const narrationSource = audioContext.createMediaElementSource(narEl);
            const videoGain = audioContext.createGain();
            const narrationGain = audioContext.createGain();
            videoGainRef.current = videoGain;
            narrationGainRef.current = narrationGain;
            videoGain.gain.value = videoVolume / 100;
            narrationGain.gain.value = narrationVolume / 100;
            videoSource.connect(videoGain);
            narrationSource.connect(narrationGain);
            videoGain.connect(audioContext.destination);
            narrationGain.connect(audioContext.destination);
          }
        } catch (err) {
          console.warn('Mix preview audio setup failed', err);
        }
      }
      vidEl.muted = true;
      vidEl.currentTime = t;
      narEl.currentTime = Math.min(t, narEl.duration || t);
      vidEl.play();
      narEl.play();
      setPreviewTime(t);
    } else {
      vidEl.muted = false;
      vidEl.currentTime = t;
      vidEl.play();
      setPreviewTime(t);
    }
  };

  const handleTimelineClick = (e) => {
    const el = timelineRef.current;
    if (!el) return;
    const duration = previewDuration || videoDuration || 0;
    if (duration <= 0) return;
    const rect = el.getBoundingClientRect();
    const x = e.clientX - rect.left;
    const time = (x / rect.width) * duration;
    seekAndPlay(time);
  };

  const openai = new OpenAI({
    apiKey: process.env.REACT_APP_OPENAI_API_KEY,
    dangerouslyAllowBrowser: true
  });

  const handleVideoUpload = async (event) => {
    const file = event.target.files[0];
    if (!file) return;

    setVideoFile(file);
    const url = URL.createObjectURL(file);
    setVideoUrl(url);
    setFrames([]);

    const video = document.createElement('video');
    video.src = url;
    video.preload = 'metadata';

    await new Promise((resolve) => {
      video.onloadedmetadata = () => {
        setVideoDuration(video.duration);
        resolve();
      };
    });

    setIsExtractingFrames(true);
    try {
      await extractFrames(video, video.duration);
    } finally {
      setIsExtractingFrames(false);
      setFramesProgress('');
    }
  };

  const extractFrames = async (videoElement, duration) => {
    const numFrames = 20;
    const frameInterval = duration / (numFrames + 1);
    const extractedFrames = [];
    const maxSize = 512; // resize to reduce payload and avoid freeze

    for (let i = 1; i <= numFrames; i++) {
      setFramesProgress(`Extracting frames ${i}/${numFrames}...`);

      // Yield to UI so it can update
      await new Promise((r) => setTimeout(r, 0));

      const time = frameInterval * i;

      await new Promise((resolve) => {
        const onSeeked = () => {
          videoElement.removeEventListener('seeked', onSeeked);
          const w = videoElement.videoWidth;
          const h = videoElement.videoHeight;
          const scale = Math.min(1, maxSize / Math.max(w, h));
          const cw = Math.round(w * scale);
          const ch = Math.round(h * scale);

          const canvas = document.createElement('canvas');
          canvas.width = cw;
          canvas.height = ch;
          const ctx = canvas.getContext('2d');
          ctx.drawImage(videoElement, 0, 0, w, h, 0, 0, cw, ch);

          canvas.toBlob(
            (blob) => {
              extractedFrames.push(blob);
              resolve();
            },
            'image/jpeg',
            0.8
          );
        };

        videoElement.addEventListener('seeked', onSeeked);
        videoElement.currentTime = time;
      });
    }

    setFrames(extractedFrames);
  };

  const loadPromptTemplate = async () => {
    try {
      const response = await fetch('/prompt_narration.txt');
      const template = await response.text();
      
      // Calculate num_words based on video duration (100 words per minute)
      const numWords = Math.round((videoDuration / 60) * 100);
      
      return template
        .replace('{num_words}', numWords)
        .replace('{instructions}', instructions);
    } catch (error) {
      console.error('Error loading prompt template:', error);
      return instructions;
    }
  };

  const createNarrationText = async () => {
    if (!frames.length || !instructions || !videoDuration) {
      alert('Please upload a video and enter instructions');
      return;
    }

    setIsGeneratingText(true);
    try {
      const prompt = await loadPromptTemplate();

      // Convert frames to base64 data URLs (yield between each to keep UI responsive)
      const imageInputs = [];
      for (let i = 0; i < frames.length; i++) {
        await new Promise((r) => setTimeout(r, 0));
        const dataUrl = await new Promise((resolve) => {
          const reader = new FileReader();
          reader.onloadend = () => resolve(reader.result);
          reader.readAsDataURL(frames[i]);
        });
        imageInputs.push({ type: 'input_image', image_url: dataUrl });
      }

      const response = await openai.responses.create({
        model: process.env.REACT_APP_MODEL || 'gpt-4o',
        input: [
          {
            role: 'user',
            content: [
              {
                type: 'input_text',
                text: prompt
              },
              ...imageInputs
            ]
          }
        ]
      });

      // Extract text from response
      const outputText = response.output
        .filter(item => item.type === 'message')
        .flatMap(item => item.content)
        .filter(content => content.type === 'output_text')
        .map(content => content.text)
        .join('\n');

      setNarrationText(outputText);
    } catch (error) {
      console.error('Error generating narration:', error);
      alert('Error generating narration: ' + error.message);
    } finally {
      setIsGeneratingText(false);
    }
  };

  const createNarrationAudio = async () => {
    if (!narrationText) {
      alert('Please generate narration text first');
      return;
    }

    setIsGeneratingAudio(true);
    try {
      const mp3 = await openai.audio.speech.create({
        model: 'gpt-4o-mini-tts',
        voice: 'nova',
        input: narrationText
      });

      const buffer = await mp3.arrayBuffer();
      const blob = new Blob([buffer], { type: 'audio/mpeg' });
      const url = URL.createObjectURL(blob);
      setNarrationAudioUrl(url);
    } catch (error) {
      console.error('Error generating audio:', error);
      alert('Error generating audio: ' + error.message);
    } finally {
      setIsGeneratingAudio(false);
    }
  };

  const loadFfmpeg = async () => {
    if (ffmpegRef.current?.loaded) return;
    const ffmpeg = ffmpegRef.current || (ffmpegRef.current = new FFmpeg());
    const baseURL = 'https://cdn.jsdelivr.net/npm/@ffmpeg/core@0.12.10/dist/umd';
    await ffmpeg.load({
      coreURL: await toBlobURL(`${baseURL}/ffmpeg-core.js`, 'text/javascript'),
      wasmURL: await toBlobURL(`${baseURL}/ffmpeg-core.wasm`, 'application/wasm'),
    });
    setFfmpegLoaded(true);
  };

  const mergeVideoWithAudio = async () => {
    if (!videoFile || !narrationAudioUrl) {
      alert('Please upload a video and generate narration audio first');
      return;
    }

    setIsMerging(true);
    const videoIn = 'in_video';
    const narrationIn = 'in_narration.mp3';
    const outputName = 'out.mp4';
    const root = '/';
    const narrationPath = root + narrationIn;
    const outputPath = root + outputName;

    try {
      await loadFfmpeg();
      const ffmpeg = ffmpegRef.current;

      const ext = (videoFile.name && /\.\w+$/.test(videoFile.name))
        ? videoFile.name.replace(/^.*\./, '')
        : 'mp4';
      const videoName = `${videoIn}.${ext}`;
      const videoFullPath = root + videoName;

      const toU8 = (x) => (x instanceof Uint8Array ? new Uint8Array(x) : x);

      try {
        const list = await ffmpeg.listDir(root);
        const toRemove = [videoName, narrationIn, outputName];
        for (const f of list) {
          if (!f.isDir && toRemove.includes(f.name)) {
            await ffmpeg.deleteFile(root + f.name);
          }
        }
      } catch (_) {}

      let videoData;
      let narrationData;
      try {
        videoData = toU8(await fetchFile(videoFile));
        narrationData = toU8(await fetchFile(narrationAudioUrl));
      } catch (e) {
        throw new Error('Reading files: ' + (e?.message || e));
      }
      try {
        await ffmpeg.writeFile(videoFullPath, videoData);
        await ffmpeg.writeFile(narrationPath, narrationData);
      } catch (e) {
        throw new Error('Writing to FFmpeg (video may be too large): ' + (e?.message || e));
      }

      const v1 = videoVolume / 100;
      const v2 = narrationVolume / 100;
      // Simple mix: both tracks with volume, then amix (reliable; ducking can drop narration in some builds)
      const filterSimple = `[0:a]volume=${v1}[a1];[1:a]volume=${v2}[a2];[a1][a2]amix=inputs=2:duration=longest[outa]`;

      const runMerge = (filter, mapOut = '[outa]') =>
        ffmpeg.exec([
          '-i', videoFullPath,
          '-i', narrationPath,
          '-filter_complex', filter,
          '-map', '0:v:0',
          '-map', mapOut,
          '-c:v', 'copy',
          '-c:a', 'aac',
          '-b:a', '192k',
          outputPath,
        ]);

      try {
        await runMerge(filterSimple);
      } catch (firstErr) {
        const msg = String(firstErr?.message || firstErr);
        const noVideoAudio = msg.includes('0:a') || msg.includes('did not match') || msg.includes('Stream specifier');
        if (noVideoAudio) {
          await ffmpeg.exec([
            '-i', videoFullPath,
            '-i', narrationPath,
            '-map', '0:v:0',
            '-map', '1:a:0',
            '-c:v', 'copy',
            '-c:a', 'aac',
            '-filter:a', `volume=${v2}`,
            '-shortest',
            outputPath,
          ]);
        } else {
          throw firstErr;
        }
      }

      let data;
      try {
        data = await ffmpeg.readFile(outputPath);
      } catch (readErr) {
        try {
          const list = await ffmpeg.listDir(root);
          const mp4 = list.find((f) => !f.isDir && f.name.endsWith('.mp4'));
          if (mp4) {
            data = await ffmpeg.readFile(root + mp4.name);
          } else {
            throw readErr;
          }
        } catch (e) {
          throw new Error('Reading output (merge may have failed): ' + (e?.message || e));
        }
      }
      const blob = new Blob([data instanceof Uint8Array ? new Uint8Array(data) : data], { type: 'video/mp4' });
      setMergedVideoUrl(URL.createObjectURL(blob));

      try {
        await ffmpeg.deleteFile(videoFullPath);
        await ffmpeg.deleteFile(narrationPath);
        await ffmpeg.deleteFile(outputPath);
      } catch (_) {}
    } catch (error) {
      console.error('Error merging video:', error);
      const msg = String(error?.message || error);
      const hint = (msg.includes('FS') || msg.includes('Errno')) && videoFile?.size > 100 * 1024 * 1024
        ? ' Try a shorter or smaller video (e.g. under 100 MB).'
        : '';
      alert('Error merging video: ' + msg + hint);
    } finally {
      setIsMerging(false);
    }
  };

  const downloadVideo = () => {
    if (!mergedVideoUrl) {
      alert('Please create a merged video first');
      return;
    }

    const base = videoFile?.name ? videoFile.name.replace(/\.[^.]+$/, '') : 'video';
    const now = new Date();
    const datetime = now.getFullYear() +
      '-' + String(now.getMonth() + 1).padStart(2, '0') +
      '-' + String(now.getDate()).padStart(2, '0') + '_' +
      String(now.getHours()).padStart(2, '0') +
      '-' + String(now.getMinutes()).padStart(2, '0') +
      '-' + String(now.getSeconds()).padStart(2, '0');
    const filename = `${base}_ai_narration_${datetime}.mp4`;

    const a = document.createElement('a');
    a.href = mergedVideoUrl;
    a.download = filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);
  };

  return (
    <div className="App">
      <header className="App-header">
        <h1>AI Video Narrator</h1>
        
        <div className="tabs">
          <button
            className={activeTab === 'narration' ? 'active' : ''}
            onClick={() => setActiveTab('narration')}
          >
            Narration
          </button>
          <button
            className={activeTab === 'mixing' ? 'active' : ''}
            onClick={() => setActiveTab('mixing')}
          >
            Audio Mixing
          </button>
        </div>

        {activeTab === 'narration' && (
          <div className="narration-tab">
            <div className="upload-section">
              <h2>Upload Video</h2>
              <input
                type="file"
                accept="video/*"
                onChange={handleVideoUpload}
                disabled={isExtractingFrames}
              />
              {isExtractingFrames && (
                <p className="progress-message">{framesProgress}</p>
              )}
              {videoUrl && (
                <div className="video-preview">
                  <video
                    ref={videoRef}
                    src={videoUrl}
                    controls
                    style={{ maxWidth: '100%', maxHeight: '520px' }}
                  />
                </div>
              )}
            </div>

            <div className="instructions-section">
              <h2>Instructions</h2>
              <textarea
                value={instructions}
                onChange={(e) => setInstructions(e.target.value)}
                placeholder="Enter your narration instructions here..."
                rows={4}
                style={{ width: '100%', maxWidth: '600px' }}
              />
            </div>

            <div className="narration-section">
              <button
                className={isGeneratingText ? 'btn-loading' : ''}
                onClick={createNarrationText}
                disabled={isGeneratingText || !frames.length || !instructions}
              >
                {isGeneratingText ? 'Generating...' : 'Create Narration Text'}
              </button>

              {narrationText && (
                <div className="narration-text-section">
                  <h2>Narration Text</h2>
                  <textarea
                    value={narrationText}
                    onChange={(e) => setNarrationText(e.target.value)}
                    rows={8}
                    style={{ width: '100%', maxWidth: '600px' }}
                  />
                </div>
              )}

              {narrationText && (
                <div className="audio-section">
                  <button
                    className={isGeneratingAudio ? 'btn-loading' : ''}
                    onClick={createNarrationAudio}
                    disabled={isGeneratingAudio || !narrationText}
                  >
                    {isGeneratingAudio ? 'Generating...' : 'Create Narration Audio'}
                  </button>

                  {narrationAudioUrl && (
                    <div className="audio-player">
                      <audio
                        ref={narrationAudioRef}
                        src={narrationAudioUrl}
                        controls
                        style={{ width: '100%', maxWidth: '600px', marginTop: '10px' }}
                      />
                    </div>
                  )}
                </div>
              )}
            </div>
          </div>
        )}

        {activeTab === 'mixing' && (
          <div className="mixing-tab editor-layout">
            <div className="editor-topbar">
              <h2 className="editor-title">Audio Mixing</h2>
              <button
                className="export-btn"
                onClick={downloadVideo}
                disabled={!mergedVideoUrl}
              >
                Export
              </button>
            </div>

            <div className="editor-preview">
              {(mergedVideoUrl ? mergedVideoUrl : videoUrl) && (
                <video
                  ref={mergedVideoUrl ? mergedVideoRef : videoRef}
                  src={mergedVideoUrl || videoUrl}
                  controls
                  className="preview-video"
                  onTimeUpdate={(e) => setPreviewTime(e.target.currentTime)}
                  onLoadedMetadata={(e) => {
                    setPreviewTime(0);
                    setPreviewDuration(e.target.duration);
                  }}
                  onPause={() => {
                    if (!mergedVideoUrl && videoRef.current) videoRef.current.muted = false;
                  }}
                  onEnded={() => {
                    if (!mergedVideoUrl && videoRef.current) videoRef.current.muted = false;
                    if (mixingNarrationRef.current) mixingNarrationRef.current.pause();
                  }}
                />
              )}
            </div>

            <div className="playback-controls">
              <span className="time-display">{formatTime(previewTime)}</span>
              <span className="time-separator">/</span>
              <span className="time-display">{formatTime(previewDuration || videoDuration || 0)}</span>
            </div>

            <div
              ref={timelineRef}
              className="timeline-wrap timeline-clickable"
              onClick={handleTimelineClick}
              role="slider"
              aria-label="Timeline position"
              tabIndex={0}
              onKeyDown={(e) => {
                const d = previewDuration || videoDuration || 0;
                if (d <= 0) return;
                const step = e.key === 'ArrowRight' ? 2 : e.key === 'ArrowLeft' ? -2 : 0;
                if (step === 0) return;
                e.preventDefault();
                seekAndPlay(previewTime + step);
              }}
            >
              <div className="timeline-ruler">
                {Array.from({ length: Math.ceil((previewDuration || videoDuration || 1) / 3) + 1 }, (_, i) => (
                  <span key={i} className="timeline-tick" style={{ left: `${(i * 3 / (previewDuration || videoDuration || 1)) * 100}%` }}>
                    {formatTime(i * 3)}
                  </span>
                ))}
              </div>
              <div className="timeline-playhead" style={{ left: `${((previewTime / (previewDuration || videoDuration || 1)) * 100)}%` }} />
            </div>
            {narrationAudioUrl && (
              <audio ref={mixingNarrationRef} src={narrationAudioUrl} style={{ display: 'none' }} />
            )}

            <div className="track-rows">
              <div className="track-row">
                <span className="track-label">Video audio</span>
                <div className="track-bar-wrap">
                  <div className="track-bar track-video" style={{ width: '100%' }} />
                </div>
                <div className="track-volume">
                  <span>{videoVolume}%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={videoVolume}
                    onChange={(e) => setVideoVolume(parseInt(e.target.value))}
                  />
                </div>
              </div>
              <div className="track-row">
                <span className="track-label">AI Narration</span>
                <div className="track-bar-wrap">
                  <div className="track-bar track-narration" style={{ width: '100%' }} />
                </div>
                <div className="track-volume">
                  <span>{narrationVolume}%</span>
                  <input
                    type="range"
                    min="0"
                    max="100"
                    value={narrationVolume}
                    onChange={(e) => setNarrationVolume(parseInt(e.target.value))}
                  />
                </div>
              </div>
            </div>

            <div className="editor-actions">
              <button
                className={isMerging ? 'btn-loading' : ''}
                onClick={mergeVideoWithAudio}
                disabled={isMerging || !videoFile || !narrationAudioUrl}
              >
                {isMerging ? 'Creating Video...' : 'Create Video'}
              </button>
            </div>
          </div>
        )}
      </header>
    </div>
  );
}

export default App;
