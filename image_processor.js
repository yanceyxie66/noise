/* ******************************************************
 * ========== 图像处理与主逻辑模块 (image_processor.js) ==========
 * ******************************************************/

// 假设 metadata.js 已经加载并将接口挂载到 window.metadataAPI
// 需要在 HTML 中先加载 metadata.js
if (typeof window.metadataAPI === 'undefined') {
    console.error("metadataAPI is not loaded. Please ensure metadata.js is loaded before image_processor.js.");
}

document.addEventListener('DOMContentLoaded', () => {

    /* ========== 核心状态变量 ========== */
    let currentReplacement = 'PASTE';    
    let currentOriginalU8Array = null;    
    let currentIsJpeg = false;
    let currentIsPng = false;
    let isImageLoaded = false;    
    let isAdvSampleGenerated = false;    
    
    // --- 核心修改 1: 定义可复现的扰动参数 ---
    const ADVERSARIAL_PARAMS = {
        'PASTE': { 
            seed: 12345, 
            alpha: 0.25, 
            density: 0.6, 
            R_MAX: 255, 
            G_MAX: 120, 
            B_MAX: 120,
            WHITE_NOISE_CHANCE: 0.2 
        },
        'FIGHT': { 
            seed: 67890, 
            alpha: 0.25, 
            density: 0.6, 
            R_MAX: 120, 
            G_MAX: 120, 
            B_MAX: 255, 
            WHITE_NOISE_CHANCE: 0.2 
        }
    };
    
    // 用于存储两个固定扰动样本的Canvas像素数据 (仅用于中间的视觉显示)
    const fixedNoiseData = {
        'paste': null,    
        'fight': null    
    };
    
    // 隐藏的 Canvas 用于处理和导出原始尺寸图片
    const hiddenProcessCanvas = document.createElement('canvas');
    const hiddenCtx = hiddenProcessCanvas.getContext('2d');

    /* ========== 伪随机数生成器 (PRNG) - 用于生成可重现的噪点 ========== */
    let currentSeed = 12345;
    function setSeed(seed) {
        currentSeed = seed;
    }
    function random() {
        currentSeed = (currentSeed * 1664525 + 1013904223) % 4294967296;
        return currentSeed / 4294967296;
    }

    /* ========== DOM 元素 ========== */
    const fileInput = document.getElementById('file-input');
    const originalCanvas = document.getElementById('original-image-canvas');
    const originalCtx = originalCanvas.getContext('2d');
    const originalPlaceholder = document.getElementById('original-placeholder');
    const outputCanvas = document.getElementById('output-image-canvas');
    const outputCtx = outputCanvas.getContext('2d');
    const outputPlaceholder = document.getElementById('output-placeholder');
    const noiseDisplayContainer = document.getElementById('noise-image-display');    
    let noiseCanvas = null;    
    let noiseCtx = null;    
    const downloadBtn = document.getElementById('download-btn');
    const generateBtn = document.getElementById('generate-btn');    
    const message = document.getElementById('instruction-area'); // 引用新的 ID
    const noiseTypeSelect = document.getElementById('noise-type-select');

    let lastObjectUrl = null;
    let currentFileName = 'image';
    let currentFileMimeType = '';
    let currentImageElement = null;

    function pageLog(...args) { console.log('[LOG]:', ...args); }

    /* =======================================
     * ========== 初始化及辅助函数 ==========
     * ======================================= */

    const PREVIEW_CANVAS_WIDTH = 250;
    const PREVIEW_CANVAS_HEIGHT = 200;
    
    /**
     * 绘制随机噪点，并可以存储为固定扰动样本（仅用于中间预览框）。
     */
    function drawRandomNoise(canvasElement, context, params, saveKey = null) {
        if (!canvasElement || !context) return;

        canvasElement.width = PREVIEW_CANVAS_WIDTH;
        canvasElement.height = PREVIEW_CANVAS_HEIGHT;

        if (saveKey && fixedNoiseData[saveKey]) {
             context.putImageData(fixedNoiseData[saveKey], 0, 0);
             return;
        }

        const imageData = context.createImageData(PREVIEW_CANVAS_WIDTH, PREVIEW_CANVAS_HEIGHT);
        const data = imageData.data;
        
        for (let i = 0; i < data.length; i += 4) {
            if (random() < params.density) {    
                let r, g, b;
                
                // 核心修改 2: 引入白色杂色逻辑 (预览保持杂色感)
                if (random() < params.WHITE_NOISE_CHANCE) {
                    const whiteVal = Math.floor(200 + random() * 55); 
                    r = whiteVal;
                    g = whiteVal;
                    b = whiteVal;
                } else {
                    // 根据参数生成 R/G/B
                    r = Math.floor(random() * params.R_MAX);
                    g = Math.floor(random() * params.G_MAX);
                    b = Math.floor(random() * params.B_MAX);
                }
                
                data[i] = r;        
                data[i + 1] = g;    
                data[i + 2] = b;    
                data[i + 3] = 255;    
            } else {
                data[i] = 30;        
                data[i + 1] = 30;    
                data[i + 2] = 30;    
                data[i + 3] = 255;    
            }
        }
        
        context.putImageData(imageData, 0, 0);

        if (saveKey) {
            // 重新设置种子以确保下次 generateNoiseMap 调用时能从正确的起点开始
            setSeed(ADVERSARIAL_PARAMS[currentReplacement].seed); 
            fixedNoiseData[saveKey] = context.getImageData(0, 0, PREVIEW_CANVAS_WIDTH, PREVIEW_CANVAS_HEIGHT);
        }
    }

    function drawFixedNoise(key) {
        if (!noiseCtx) return;
        const params = ADVERSARIAL_PARAMS[key.toUpperCase()];
        if (!params) return;

        // 设置种子并绘制
        setSeed(params.seed);    
        drawRandomNoise(noiseCanvas, noiseCtx, params, key);
        // 绘制完后，再次设置种子以确保 generateNoiseMap 可以从头开始生成完整的噪点图
        setSeed(params.seed);
    }
    
    function initializeNoiseCanvas() {
        if (!noiseCanvas) {
            noiseCanvas = document.createElement('canvas');
            noiseCanvas.id = 'noise-canvas';
            noiseDisplayContainer.prepend(noiseCanvas);
            noiseCtx = noiseCanvas.getContext('2d');
            
            noiseCanvas.style.width = '100%';
            noiseCanvas.style.height = '100%';
        }
        
        drawFixedNoise('paste');    
    }
    
    /**
     * 在指定 Canvas 上绘制缩放后的图片（预览用）。
     */
    function drawScaledImage(ctx, img) {
        const canvas = ctx.canvas;
        canvas.width = PREVIEW_CANVAS_WIDTH;
        canvas.height = PREVIEW_CANVAS_HEIGHT;
        const ratio = Math.min(canvas.width / img.width, canvas.height / img.height);
        const newWidth = img.width * ratio;
        const newHeight = img.height * ratio;
        const x = (canvas.width - newWidth) / 2;
        const y = (canvas.height - newHeight) / 2;
        ctx.clearRect(0, 0, canvas.width, canvas.height);    
        ctx.drawImage(img, x, y, newWidth, newHeight);
    }
    
    /**
     * 生成与目标图片尺寸一致的扰动像素数组。
     */
    function generateNoiseMap(width, height, noiseKey) {
        const params = ADVERSARIAL_PARAMS[noiseKey.toUpperCase()];
        
        setSeed(params.seed); // 设定种子，确保噪点可重现
        
        const noiseData = new Uint8ClampedArray(width * height * 4);

        for (let i = 0; i < noiseData.length; i += 4) {
            if (random() < params.density) {    
                let r, g, b;
                
                // 核心修改 2: 引入白色杂色逻辑 (最终图片上的噪点也需要)
                if (random() < params.WHITE_NOISE_CHANCE) {
                    const whiteVal = Math.floor(200 + random() * 55); 
                    r = whiteVal;
                    g = whiteVal;
                    b = whiteVal;
                } else {
                    // 根据参数生成 R/G/B
                    r = Math.floor(random() * params.R_MAX);
                    g = Math.floor(random() * params.G_MAX);
                    b = Math.floor(random() * params.B_MAX);
                }
                
                noiseData[i] = r;        
                noiseData[i + 1] = g;    
                noiseData[i + 2] = b;    
                noiseData[i + 3] = 255; // Alpha
            } else {
                noiseData[i] = 30;        
                noiseData[i + 1] = 30;    
                noiseData[i + 2] = 30;    
                noiseData[i + 3] = 255;    
            }
        }
        return noiseData;
    }

    /**
     * 将扰动叠加到原始像素数据上。
     */
    function applyNoiseOverlay(originalData, noiseData, alpha) {
        const len = originalData.length;
        for (let i = 0; i < len; i += 4) {
            // 混合颜色 (线性插值)
            originalData[i] = Math.round(originalData[i] * (1 - alpha) + noiseData[i] * alpha);
            originalData[i + 1] = Math.round(originalData[i + 1] * (1 - alpha) + noiseData[i + 1] * alpha);
            originalData[i + 2] = Math.round(originalData[i + 2] * (1 - alpha) + noiseData[i + 2] * alpha);
            // Alpha通道保持不变 (原图alpha)
        }
    }
    

    /* =======================================
     * ========== 主流程与事件绑定 ==========
     * ======================================= */

    initializeNoiseCanvas();

    function resetUIState(msg = '（等待上传...）') {
        if (lastObjectUrl) {
            URL.revokeObjectURL(lastObjectUrl);
            lastObjectUrl = null;
        }
        
        currentOriginalU8Array = null;
        currentIsJpeg = false;
        currentIsPng = false;
        isImageLoaded = false;
        isAdvSampleGenerated = false;
        currentImageElement = null;

        // message.textContent = ''; // 保持静态说明
        downloadBtn.classList.remove('active');
        downloadBtn.href = '#';
        downloadBtn.download = '';
        generateBtn.classList.add('disabled');
        generateBtn.disabled = true;

        originalCanvas.style.display = 'none';
        originalPlaceholder.style.display = 'flex';
        originalPlaceholder.textContent = msg;
        
        outputCanvas.style.display = 'none';
        outputPlaceholder.style.display = 'flex';
        outputPlaceholder.textContent = '（等待生成...）';

        drawFixedNoise(currentReplacement.toLowerCase());
    }

    noiseTypeSelect.addEventListener('change', (e) => {
        currentReplacement = e.target.value.toUpperCase();    
        pageLog('切换扰动样本载荷:', currentReplacement);
        
        drawFixedNoise(e.target.value);    

        if (isImageLoaded) {
            isAdvSampleGenerated = false;    
            generateBtn.classList.remove('disabled');
            generateBtn.disabled = false;
            downloadBtn.classList.remove('active');
            downloadBtn.href = '#';
            
            // const alphaPercent = Math.round(ADVERSARIAL_PARAMS[currentReplacement].alpha * 100); // 保持静态说明
            // message.textContent = `已选择扰动，强度设置为 ${alphaPercent}%，请点击“生成图片”。`;    
            
            outputCanvas.style.display = 'none';
            outputPlaceholder.style.display = 'flex';
            outputPlaceholder.textContent = '（等待生成...）';
        }
    });

    fileInput.addEventListener('change', async (e) => {
        resetUIState();
        // message.textContent = '开始读取文件...'; // 保持静态说明

        const f = e.target.files && e.target.files[0];
        if (!f) {
            resetUIState();
            return;
        }
        
        currentFileMimeType = f.type;
        currentFileName = f.name.replace(/\.[^/.]+$/, '') || 'image';
        pageLog('\n=== 上传文件：', f.name, Math.round(f.size / 1024) + 'KB ===');

        try {
            currentOriginalU8Array = new Uint8Array(await f.arrayBuffer());
        } catch (error) {
            // message.textContent = '错误：无法读取文件。'; // 保持静态说明
            drawFixedNoise(currentReplacement.toLowerCase());
            return;
        }
        
        currentIsJpeg = window.metadataAPI.isJpeg(currentOriginalU8Array);
        currentIsPng = window.metadataAPI.isPng(currentOriginalU8Array);

        if (!currentIsJpeg && !currentIsPng) {
            // message.textContent = '警告：不支持的格式。请上传 JPEG 或 PNG。'; // 保持静态说明
            drawFixedNoise(currentReplacement.toLowerCase());
            return;
        }

        const img = new Image();
        const fileUrl = URL.createObjectURL(f);
        
        img.onload = () => {
            currentImageElement = img; 
            drawScaledImage(originalCtx, img);
            originalCanvas.style.display = 'block';    
            originalPlaceholder.style.display = 'none';    
            URL.revokeObjectURL(fileUrl);

            isImageLoaded = true;
            generateBtn.classList.remove('disabled');    
            generateBtn.disabled = false;
            
            // const alphaPercent = Math.round(ADVERSARIAL_PARAMS[currentReplacement].alpha * 100); // 保持静态说明
            // message.textContent = `图片已加载，请选择扰动样本 (当前强度: ${alphaPercent}%)。`;    
        };
        img.onerror = () => {
            URL.revokeObjectURL(fileUrl);
            resetUIState('（预览失败）');
            // message.textContent = '错误：无法加载图片预览。'; // 保持静态说明
        };
        img.src = fileUrl;
    });
    
    generateBtn.addEventListener('click', () => {
        if (!isImageLoaded || !currentImageElement) {
            // message.textContent = '请先上传图片。';    // 保持静态说明
            return;
        }
        if (isAdvSampleGenerated) {
            // message.textContent = '图片已生成，请下载。';    // 保持静态说明
            return;
        }
        
        generateBtn.classList.add('disabled');
        generateBtn.disabled = true;
        downloadBtn.classList.remove('active');

        // message.textContent = '正在生成对抗样本 (添加视觉扰动和元数据)...';    // 保持静态说明
        
        drawFixedNoise(currentReplacement.toLowerCase());    

        setTimeout(() => processFile(), 100);
    });

    async function processFile() {
        if (!currentImageElement) return;

        const params = ADVERSARIAL_PARAMS[currentReplacement];

        // 1. **进行像素级的微小扰动 (Canvas)**
        const { width, height } = currentImageElement;
        hiddenProcessCanvas.width = width;
        hiddenProcessCanvas.height = height;
        hiddenCtx.drawImage(currentImageElement, 0, 0, width, height);
        
        const imageData = hiddenCtx.getImageData(0, 0, width, height);
        const originalPixels = imageData.data;
        
        const noisePixels = generateNoiseMap(width, height, currentReplacement);
        
        // 使用 params.alpha 来控制强度
        applyNoiseOverlay(originalPixels, noisePixels, params.alpha); 
        
        hiddenCtx.putImageData(imageData, 0, 0);
        
        // 2. 将修改了像素的图片导出为新的 Data URL/Blob
        const modifiedPixelDataUrl = hiddenProcessCanvas.toDataURL(
            currentFileMimeType, 
            currentIsJpeg ? 0.9 : 1.0 
        );
        
        // 3. 将 Data URL 转换为 Uint8Array
        const modifiedPixelBlob = await fetch(modifiedPixelDataUrl).then(res => res.blob());
        const modifiedPixelU8Array = new Uint8Array(await modifiedPixelBlob.arrayBuffer());
        
        // 4. 对这个视觉上已修改的图片进行元数据（对抗攻击）修改
        let outU8;
        const replacementStr = currentReplacement; // PASTE 或 FIGHT
        try {
            if (currentIsJpeg) {
                outU8 = window.metadataAPI.processJpeg(modifiedPixelU8Array.slice(), replacementStr);    
            } else if (currentIsPng) {
                outU8 = window.metadataAPI.processPng(modifiedPixelU8Array.slice(), replacementStr);
            } else {
                throw new Error('Unsupported format during final processing.');
            }
        } catch (error) {
            pageLog('生成图片失败:', error);    
            // message.textContent = '致命错误：元数据注入过程失败。';    // 保持静态说明
            generateBtn.classList.remove('disabled');
            generateBtn.disabled = false;
            return;
        }

        // 5. 生成最终的下载文件 Blob
        const outBlob = new Blob([outU8], { type: currentFileMimeType });
        if (lastObjectUrl) {
            URL.revokeObjectURL(lastObjectUrl);
        }
        lastObjectUrl = URL.createObjectURL(outBlob);

        // 6. 更新预览
        const outImg = new Image();
        outImg.onload = () => {
            drawScaledImage(outputCtx, outImg);
            
            outputCanvas.style.display = 'block';    
            outputPlaceholder.style.display = 'none';    
            
            isAdvSampleGenerated = true;    
            
            const ext = currentIsPng ? '.png' : '.jpg';
            // === 核心修改: 修改下载文件名 ===
            // 文件名使用编号：对抗样本_1.jpg 或 对抗样本_2.jpg
            const index = (currentReplacement === 'PASTE' ? 1 : 2); 
            downloadBtn.href = lastObjectUrl;
            downloadBtn.download = `对抗样本_${index}` + ext; 
            downloadBtn.classList.add('active');    

            // const alphaPercent = Math.round(params.alpha * 100); // 保持静态说明
            // message.textContent = `图片生成完毕！扰动样本已包含像素级和元数据级扰动 (强度: ${alphaPercent}%)。`;    
            pageLog('处理完成：已生成可下载的对抗样本。');    
        };
        outImg.onerror = () => {
            // message.textContent = '警告：图片生成成功，但预览失败。请尝试下载。'; // 保持静态说明
            outputPlaceholder.textContent = '（预览失败，请下载）';
            
            const ext = currentIsPng ? '.png' : '.jpg';
            const index = (currentReplacement === 'PASTE' ? 1 : 2);
            downloadBtn.href = lastObjectUrl;
            downloadBtn.download = `对抗样本_${index}` + ext; 
            downloadBtn.classList.add('active');    
        };
        outImg.src = lastObjectUrl;
    }

    downloadBtn.addEventListener('click', (e) => {
        if (!downloadBtn.classList.contains('active')) {
            e.preventDefault();
            // message.textContent = '请先上传图片并生成图片。';    // 保持静态说明
            return;
        }
        pageLog('用户点击下载图片。');    
    });
});