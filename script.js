document.addEventListener('DOMContentLoaded', () => {
    // Elements
    const dropZone = document.getElementById('drop-zone');
    const fileInput = document.getElementById('file-input');
    const fileNameDisplay = document.getElementById('file-name');
    const convertBtn = document.getElementById('convert-btn');
    const styleInputs = document.querySelectorAll('input[name="style"]');

    const uploadSection = document.getElementById('upload-section');
    const processingSection = document.getElementById('processing-section');
    const resultSection = document.getElementById('result-section');
    const progressBar = document.getElementById('progress-bar');
    const progressText = document.getElementById('progress-text');
    const adContainer = document.getElementById('ad-container');
    const downloadBtn = document.getElementById('download-btn');
    const restartBtn = document.getElementById('restart-btn');

    let selectedFile = null;
    let selectedStyle = 'scratch';
    let mediaRecorder = null;
    let recordedChunks = [];
    let processedVideoURL = null;
    let isProcessing = false;
    let watchdogTimer = null; // Safety timer

    // --- File Handling ---
    const browseBtn = document.getElementById('browse-btn-click');
    if (browseBtn) {
        browseBtn.addEventListener('click', (e) => {
            e.stopPropagation(); // Stop bubbling to dropZone
            fileInput.click();
        });
    }

    dropZone.addEventListener('click', (e) => {
        if (e.target.id === 'file-input') return; // Don't trigger if clicking the input itself
        if (e.target.closest('.style-option')) return; // Don't trigger on style options
        if (e.target.tagName === 'BUTTON') return; // Button has its own handler (or we remove it and handle here)

        fileInput.click();
    });

    fileInput.addEventListener('change', (e) => {
        if (e.target.files.length > 0) handleFile(e.target.files[0]);
    });

    dropZone.addEventListener('dragover', (e) => { e.preventDefault(); dropZone.style.borderColor = '#d4af37'; });
    dropZone.addEventListener('dragleave', () => { dropZone.style.borderColor = '#333'; });
    dropZone.addEventListener('drop', (e) => { e.preventDefault(); dropZone.style.borderColor = '#333'; if (e.dataTransfer.files.length > 0) handleFile(e.dataTransfer.files[0]); });

    function handleFile(file) {
        if (!file.type.startsWith('video/')) { alert('Please upload a valid video.'); return; }
        selectedFile = file;
        fileNameDisplay.textContent = file.name;
        convertBtn.disabled = false;
    }

    styleInputs.forEach(input => { input.addEventListener('change', (e) => { selectedStyle = e.target.value; }); });

    // --- Processing ---
    convertBtn.addEventListener('click', async () => {
        if (!selectedFile) return;
        uploadSection.classList.add('hidden');
        uploadSection.classList.remove('active');
        processingSection.classList.remove('hidden');
        processingSection.classList.add('active');
        adContainer.style.display = 'block';
        progressBar.style.width = '0%';
        if (progressText) progressText.textContent = '0%';

        await new Promise(r => setTimeout(r, 100));
        startProcessing(selectedFile);
    });

    async function startProcessing(file) {
        isProcessing = true;

        const video = document.createElement('video');
        video.src = URL.createObjectURL(file);
        video.muted = false;
        video.muted = false;
        video.volume = 1.0; // Audio must be on for capture
        video.style.display = 'none';

        await new Promise((resolve) => {
            video.onloadedmetadata = () => resolve();
            setTimeout(resolve, 3000); // 3s Timeout
        });

        const duration = video.duration || 10; // Fallback duration

        const canvas = document.createElement('canvas');
        const ctx = canvas.getContext('2d', { willReadFrequently: true });
        let processWidth = 854; // 480p (Safe balance for speed/quality on local)
        let scale = Math.min(1, processWidth / video.videoWidth);
        canvas.width = video.videoWidth * scale;
        canvas.height = video.videoHeight * scale;

        // Audio & Stream Setup
        const stream = canvas.captureStream(30);

        // Critical: Capture Audio using AudioContext
        let audioCtx;
        try {
            audioCtx = new (window.AudioContext || window.webkitAudioContext)();
            const source = audioCtx.createMediaElementSource(video);
            const destination = audioCtx.createMediaStreamDestination();
            source.connect(destination);

            // Audio track check
            if (destination.stream.getAudioTracks().length > 0) {
                console.log("Audio track captured successfully via AudioContext");
                stream.addTrack(destination.stream.getAudioTracks()[0]);
            } else {
                throw new Error("No audio track in destination");
            }
        } catch (e) {
            console.warn("AudioContext capture failed:", e);
            // Fallback: try video.captureStream
            try {
                // Some browsers support captureStream on video elements
                if (video.captureStream) {
                    const videoStream = video.captureStream();
                    const audioTrack = videoStream.getAudioTracks()[0];
                    if (audioTrack) {
                        console.log("Audio track captured via captureStream");
                        stream.addTrack(audioTrack);
                    }
                } else if (video.mozCaptureStream) {
                    const videoStream = video.mozCaptureStream();
                    const audioTrack = videoStream.getAudioTracks()[0];
                    if (audioTrack) {
                        console.log("Audio track captured via mozCaptureStream");
                        stream.addTrack(audioTrack);
                    }
                }
            } catch (e2) {
                console.warn("Fallback audio capture failed:", e2);
            }
        }

        try {
            // Explicitly request audio codec
            mediaRecorder = new MediaRecorder(stream, {
                mimeType: 'video/webm; codecs=vp9,opus',
                audioBitsPerSecond: 128000
            });
        } catch (e) {
            console.warn("VP9/Opus not supported, trying default.");
            mediaRecorder = new MediaRecorder(stream, { mimeType: 'video/webm' });
        }

        recordedChunks = [];
        mediaRecorder.ondataavailable = (e) => { if (e.data.size > 0) recordedChunks.push(e.data); };

        mediaRecorder.onstop = () => {
            const blob = new Blob(recordedChunks, { type: 'video/webm' });
            processedVideoURL = URL.createObjectURL(blob);

            // Finish Up
            adContainer.style.display = 'none';
            processingSection.classList.add('hidden');
            processingSection.classList.remove('active');
            resultSection.classList.remove('hidden');
            resultSection.classList.add('active');

            // Clean
            URL.revokeObjectURL(video.src);
            video.remove();
            canvas.remove();
            isProcessing = false;
        };

        mediaRecorder.start();
        video.currentTime = 0;

        // --- WATCHDOG TIMER ---
        // Force stop if it takes too long (Duration + 5 seconds buffer)
        // This is the CRITICAL FIX for "Stuck at 100%"
        clearTimeout(watchdogTimer);
        const timeoutMs = (duration * 1000) + 5000;
        watchdogTimer = setTimeout(() => {
            console.log("Watchdog triggered: Force stopping recording");
            if (mediaRecorder.state === 'recording') mediaRecorder.stop();
        }, timeoutMs);

        video.play().then(() => {
            requestAnimationFrame(processLoop);
        }).catch(e => {
            alert("Playback failed. Please interact with page.");
            isProcessing = false;
        });

        let lastTime = -1;
        let stuckFrames = 0;

        function processLoop() {
            if (!isProcessing) return; // Exit if already stopped by watchdog

            // Check if Done
            if (video.ended || video.currentTime >= duration) {
                if (mediaRecorder.state === 'recording') mediaRecorder.stop();
                return;
            }

            // Check if STUCK (Time not moving)
            if (video.currentTime === lastTime) {
                stuckFrames++;
                if (stuckFrames > 60) { // Stuck for ~2 seconds (30fps)
                    if (mediaRecorder.state === 'recording') mediaRecorder.stop();
                    return;
                }
            } else {
                stuckFrames = 0;
            }
            lastTime = video.currentTime;

            // Draw
            ctx.drawImage(video, 0, 0, canvas.width, canvas.height);

            // Apply Logic
            if (selectedStyle === 'scratch') applySketchEffect(ctx, canvas);
            else if (selectedStyle === 'moe') applyMoeEffect(ctx, canvas);
            else if (selectedStyle === 'kodomo') applyKodomoEffect(ctx, canvas);
            else if (selectedStyle === '3drender') apply3DRenderEffect(ctx, canvas);

            // Progress
            const percent = Math.min(100, (video.currentTime / duration) * 100);
            progressBar.style.width = `${percent}%`;
            if (progressText) progressText.textContent = `${Math.round(percent)}%`;

            // Force next frame
            if ('requestVideoFrameCallback' in video) {
                video.requestVideoFrameCallback(processLoop);
            } else {
                requestAnimationFrame(processLoop);
            }
        }
    }

    // --- Optimized Styles ---
    function applySketchEffect(ctx, canvas) {
        const w = canvas.width, h = canvas.height;
        const frame = ctx.getImageData(0, 0, w, h);
        const data = frame.data;
        // Super minimal edge detect
        for (let i = 0; i < data.length; i += 4) {
            const v = (data[i] + data[i + 1] + data[i + 2]) / 3;
            // Simple threshold
            data[i] = v > 100 ? 255 : 20;
            data[i + 1] = v > 100 ? 255 : 20;
            data[i + 2] = v > 100 ? 255 : 20;
        }
        ctx.putImageData(frame, 0, 0);
    }

    // MOE ANIME: Advanced Soft Cel Shade
    function applyMoeEffect(ctx, canvas) {
        const w = canvas.width, h = canvas.height;
        const frame = ctx.getImageData(0, 0, w, h);
        const data = frame.data;
        const copy = new Uint8ClampedArray(data);

        // 1. Edge Detection (Sobel) on Luma
        // We calculate 'Luma' first to save time in the loop
        const luma = new Uint8Array(w * h);
        for (let i = 0; i < w * h; i++) {
            // Rec 601 luma
            luma[i] = 0.299 * copy[i * 4] + 0.587 * copy[i * 4 + 1] + 0.114 * copy[i * 4 + 2];
        }

        const edges = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = y * w + x;
                // Sobel Kernel Horizontal
                const gx = -luma[idx - 1 - w] + luma[idx + 1 - w] +
                    -2 * luma[idx - 1] + 2 * luma[idx + 1] +
                    -luma[idx - 1 + w] + luma[idx + 1 + w];
                // Sobel Kernel Vertical
                const gy = -luma[idx - 1 - w] - 2 * luma[idx - w] - luma[idx + 1 - w] +
                    luma[idx - 1 + w] + 2 * luma[idx + w] + luma[idx + 1 + w];

                const mag = Math.abs(gx) + Math.abs(gy);
                // Threshold for "Moe" is usually thinner, cleaner lines
                edges[idx] = mag > 50 ? 255 : 0;
            }
        }

        // 2. Color Grading & Smoothing
        for (let i = 0; i < data.length; i += 4) {
            let r = copy[i], g = copy[i + 1], b = copy[i + 2];

            // Smart "Flat" Look (Reduce local contrast slightly to smooth skin)
            // This is a simple per-pixel approximations

            // Brightness Boost (High Key)
            r += 15; g += 15; b += 15;

            // Color Grading: Shadows -> Cool, Highlights -> Warm
            const lum = (r + g + b) / 3;
            if (lum < 128) {
                b += 10; // Blue shadow
            } else {
                r += 5; // Warm highlight
            }

            // Saturation Boost (Moe is colorful but soft)
            const avg = (r + g + b) / 3;
            r = avg + (r - avg) * 1.3;
            g = avg + (g - avg) * 1.3;
            b = avg + (b - avg) * 1.3;

            // Soft Quantization (Cel Shading but with many steps)
            // 24 levels = smooth but flattened look
            const levels = 24;
            r = Math.floor(r / (256 / levels)) * (256 / levels);
            g = Math.floor(g / (256 / levels)) * (256 / levels);
            b = Math.floor(b / (256 / levels)) * (256 / levels);

            // Clamp
            if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255; if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;

            data[i] = r; data[i + 1] = g; data[i + 2] = b;
        }

        // 3. Composite Edges (Colored Lines)
        // Moe anime rarely uses pure black lines. Use Dark Brown/Maroon.
        for (let j = 0; j < w * h; j++) {
            if (edges[j]) {
                const idx = j * 4;
                // Mix existing color with dark brown
                data[idx] = data[idx] * 0.4 + 40;   // R
                data[idx + 1] = data[idx + 1] * 0.4 + 20; // G
                data[idx + 2] = data[idx + 2] * 0.4 + 10; // B
            }
        }
        ctx.putImageData(frame, 0, 0);
    }

    // KODOMO ANIME: Vibrant, Posterized, Thick Edges
    function applyKodomoEffect(ctx, canvas) {
        const w = canvas.width, h = canvas.height;
        const frame = ctx.getImageData(0, 0, w, h);
        const data = frame.data;
        const copy = new Uint8ClampedArray(data);

        // 1. Heavy Edge Detection
        const edges = new Uint8Array(w * h);
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = (y * w + x) * 4;
                // Simple fast diff
                const diff = Math.abs(copy[idx] - copy[idx + 4]) + Math.abs(copy[idx + 1] - copy[idx + 5]) +
                    Math.abs(copy[idx] - copy[idx + w * 4]); // Vertical check

                // Low threshold = more lines
                edges[y * w + x] = diff > 20 ? 255 : 0;
            }
        }

        for (let i = 0; i < data.length; i += 4) {
            let r = data[i], g = data[i + 1], b = data[i + 2];

            // Super Saturation
            const avg = (r + g + b) / 3;
            r = avg + (r - avg) * 2.5;
            g = avg + (g - avg) * 2.5;
            b = avg + (b - avg) * 2.5;

            // Hard Posterization (8 levels)
            const levels = 8;
            r = Math.floor(r / (256 / levels)) * (256 / levels);
            g = Math.floor(g / (256 / levels)) * (256 / levels);
            b = Math.floor(b / (256 / levels)) * (256 / levels);

            // Clamp
            if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255; if (r < 0) r = 0; if (g < 0) g = 0; if (b < 0) b = 0;
            data[i] = r; data[i + 1] = g; data[i + 2] = b;
        }

        // Black Edges
        for (let j = 0; j < w * h; j++) {
            if (edges[j]) {
                const idx = j * 4;
                data[idx] = 10; data[idx + 1] = 10; data[idx + 2] = 20; // Nearly Black
            }
        }
        ctx.putImageData(frame, 0, 0);
    }

    function apply3DRenderEffect(ctx, canvas) {
        const w = canvas.width, h = canvas.height;
        const frame = ctx.getImageData(0, 0, w, h);
        const data = frame.data;
        const gray = new Uint8Array(w * h);
        for (let i = 0; i < data.length; i += 4) gray[i / 4] = 0.299 * data[i] + 0.587 * data[i + 1] + 0.114 * data[i + 2];
        for (let y = 1; y < h - 1; y++) {
            for (let x = 1; x < w - 1; x++) {
                const idx = (y * w + x) * 4; const i = y * w + x;
                const slope = (gray[i - 1] - gray[i + 1]) + (gray[i - w] - gray[i + w]);
                let light = 1.0; if (slope > 10) light = 1.3; else if (slope < -10) light = 0.7;
                let r = data[idx] * light; let g = data[idx + 1] * light; let b = data[idx + 2] * light;
                if (r > 255) r = 255; if (g > 255) g = 255; if (b > 255) b = 255;
                data[idx] = r; data[idx + 1] = g; data[idx + 2] = b;
            }
        }
        ctx.putImageData(frame, 0, 0);
    }

    // UI Listeners
    downloadBtn.addEventListener('click', () => {
        const a = document.createElement('a');
        a.href = processedVideoURL;
        a.download = `converted_${selectedStyle}.webm`;
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
    });

    restartBtn.addEventListener('click', () => {
        selectedFile = null; fileInput.value = ''; fileNameDisplay.textContent = '';
        convertBtn.disabled = true; progressBar.style.width = '0%';
        if (progressText) progressText.textContent = '0%';
        processedVideoURL = null;
        resultSection.classList.add('hidden'); resultSection.classList.remove('active');
        uploadSection.classList.remove('hidden'); uploadSection.classList.add('active');
    });
});
