// ==========================================================================
// Plyr Overlay Plugin
// Renders a <canvas> on top of the video for detection overlays
// ==========================================================================

import { createElement } from '../utils/elements';
import { on, triggerEvent } from '../utils/events';
import is from '../utils/is';

class Overlay {
  /**
   * Overlay constructor.
   * @param {Plyr} player - The Plyr instance
   */
  constructor(player) {
    this.player = player;
    this.canvas = null;
    this.ctx = null;
    this.enabled = false;
    this.ready = false;

    // Current frame data storage
    this.frameData = null;
    this.activeFrameId = null;

    // Custom renderer callback: (ctx, frameData, videoRect) => {}
    this.renderer = null;

    // Animation frame IDs for cleanup
    this._rafId = null;
    this._rvfcId = null;
    this._running = false;

    // Bound methods for event listeners
    this._onResize = this.resize.bind(this);
    this._onEnterfullscreen = this.resize.bind(this);
    this._onExitfullscreen = this.resize.bind(this);

    // Set up if enabled
    if (this.player.config.overlay.enabled) {
      this.setup();
    }
  }

  /**
   * Check if overlay is supported (video only)
   */
  get supported() {
    return this.player.isVideo;
  }

  /**
   * Create the canvas element and insert it into the video wrapper
   */
  setup() {
    if (!this.supported) {
      this.player.debug.warn('Overlay is only supported for video');
      return;
    }

    // Don't double-initialize
    if (this.ready) {
      return;
    }

    const { wrapper } = this.player.elements;
    if (!is.element(wrapper)) {
      this.player.debug.warn('Overlay setup failed: no video wrapper found');
      return;
    }

    // Create canvas element
    this.canvas = createElement('canvas', {
      class: this.player.config.classNames.overlay.canvas,
    });

    // Apply inline styles for positioning
    const config = this.player.config.overlay;
    Object.assign(this.canvas.style, {
      position: 'absolute',
      top: '0',
      left: '0',
      width: '100%',
      height: '100%',
      pointerEvents: 'none',
      zIndex: String(config.zIndex),
    });

    // Insert canvas into wrapper (after video, before controls)
    wrapper.appendChild(this.canvas);

    // Get 2D context
    this.ctx = this.canvas.getContext('2d');

    // Store reference on player elements
    this.player.elements.overlay = this.canvas;

    // Initial resize
    this.resize();

    // Bind event listeners
    this._bindListeners();

    this.enabled = true;
    this.ready = true;

    this.player.debug.log('Overlay initialized');

    // Start the render loop
    this._startLoop();
  }

  /**
   * Bind event listeners for resize and fullscreen
   */
  _bindListeners() {
    // Window resize
    window.addEventListener('resize', this._onResize);

    // Plyr fullscreen events
    on.call(this.player, this.player.elements.container, 'enterfullscreen', this._onEnterfullscreen);
    on.call(this.player, this.player.elements.container, 'exitfullscreen', this._onExitfullscreen);
  }

  /**
   * Unbind event listeners
   */
  _unbindListeners() {
    window.removeEventListener('resize', this._onResize);
  }

  /**
   * Resize the canvas to match the wrapper dimensions (in device pixels for sharp rendering)
   */
  resize() {
    if (!this.canvas) return;

    const { wrapper } = this.player.elements;
    if (!is.element(wrapper)) return;

    const rect = wrapper.getBoundingClientRect();
    const dpr = window.devicePixelRatio || 1;

    // Set canvas resolution to match physical pixels
    this.canvas.width = Math.round(rect.width * dpr);
    this.canvas.height = Math.round(rect.height * dpr);

    // Scale context so drawing code uses CSS pixels
    this.ctx.setTransform(dpr, 0, 0, dpr, 0, 0);

    // Re-render with current data
    this.render();
  }

  /**
   * Calculate the video rect within the canvas, accounting for object-fit: contain letterboxing
   * Returns { x, y, w, h } in CSS pixel coordinates
   */
  getVideoRect() {
    const { wrapper } = this.player.elements;
    if (!is.element(wrapper)) return { x: 0, y: 0, w: 0, h: 0 };

    const wrapperRect = wrapper.getBoundingClientRect();
    const cw = wrapperRect.width;
    const ch = wrapperRect.height;

    const video = this.player.media;
    const vw = video.videoWidth || 1920;
    const vh = video.videoHeight || 1080;

    if (!vw || !vh) return { x: 0, y: 0, w: cw, h: ch };

    const videoRatio = vw / vh;
    const containerRatio = cw / ch;

    let drawW;
    let drawH;
    let offsetX;
    let offsetY;

    if (containerRatio > videoRatio) {
      // Letterbox: pillarboxing (vertical fit, horizontal bars)
      drawH = ch;
      drawW = ch * videoRatio;
      offsetX = (cw - drawW) / 2;
      offsetY = 0;
    } else {
      // Letterbox: letterboxing (horizontal fit, vertical bars)
      drawW = cw;
      drawH = cw / videoRatio;
      offsetX = 0;
      offsetY = (ch - drawH) / 2;
    }

    return { x: offsetX, y: offsetY, w: drawW, h: drawH };
  }

  /**
   * Start the render loop using requestVideoFrameCallback or requestAnimationFrame
   */
  _startLoop() {
    if (this._running) return;
    this._running = true;

    const config = this.player.config.overlay;
    const video = this.player.media;

    // Try requestVideoFrameCallback first
    if (config.useVideoFrameCallback && is.function(video.requestVideoFrameCallback)) {
      this._rvfcLoop(video);
    } else {
      // Fallback to requestAnimationFrame
      this._rafLoop();
    }
  }

  /**
   * requestVideoFrameCallback-based render loop
   */
  _rvfcLoop(video) {
    if (!this._running) return;

    const callback = (_now, metadata) => {
      if (!this._running) return;

      // Trigger overlayframe event with metadata
      triggerEvent.call(this.player, this.player.media, 'overlayframe', false, {
        metadata,
      });

      // Render
      this.render();

      // Schedule next
      this._rvfcId = video.requestVideoFrameCallback(callback);
    };

    this._rvfcId = video.requestVideoFrameCallback(callback);
  }

  /**
   * requestAnimationFrame-based render loop (fallback)
   */
  _rafLoop() {
    if (!this._running) return;

    const loop = () => {
      if (!this._running) return;
      this.render();
      this._rafId = requestAnimationFrame(loop);
    };

    this._rafId = requestAnimationFrame(loop);
  }

  /**
   * Stop the render loop
   */
  _stopLoop() {
    this._running = false;

    if (this._rafId != null) {
      cancelAnimationFrame(this._rafId);
      this._rafId = null;
    }

    if (this._rvfcId != null && this.player.media && is.function(this.player.media.cancelVideoFrameCallback)) {
      this.player.media.cancelVideoFrameCallback(this._rvfcId);
      this._rvfcId = null;
    }
  }

  /**
   * Set the current frame data for rendering
   * @param {number|string} frameId - Frame identifier
   * @param {Array} detections - Array of detection objects
   */
  setFrameData(frameId, detections) {
    this.activeFrameId = frameId;
    this.frameData = detections;
  }

  /**
   * Set a custom renderer function
   * @param {Function} callback - (ctx, frameData, videoRect) => {}
   */
  setRenderer(callback) {
    if (!is.function(callback) && callback !== null) {
      this.player.debug.warn('Overlay renderer must be a function or null');
      return;
    }
    this.renderer = callback;
  }

  /**
   * Render the current frame.
   * If a custom renderer is set, it is called. Otherwise the canvas is cleared.
   */
  render() {
    if (!this.ctx || !this.canvas) return;

    const wrapperRect = this.player.elements.wrapper
      ? this.player.elements.wrapper.getBoundingClientRect()
      : null;
    if (!wrapperRect) return;

    const cssWidth = wrapperRect.width;
    const cssHeight = wrapperRect.height;

    // Clear canvas (in CSS pixel space since we've set the transform)
    this.ctx.clearRect(0, 0, cssWidth, cssHeight);

    // If there's a custom renderer and frame data, call it
    if (is.function(this.renderer)) {
      const videoRect = this.getVideoRect();
      this.renderer(this.ctx, this.frameData, videoRect, this.activeFrameId);
    }

    // Clear frame data after rendering so it doesn't persist to next frame
    this.frameData = null;
    this.activeFrameId = null;
  }

  /**
   * Clear the overlay canvas and reset frame data
   */
  clear() {
    this.frameData = null;
    this.activeFrameId = null;

    if (this.ctx && this.canvas) {
      const { wrapper } = this.player.elements;
      if (is.element(wrapper)) {
        const rect = wrapper.getBoundingClientRect();
        this.ctx.clearRect(0, 0, rect.width, rect.height);
      }
    }
  }

  /**
   * Destroy the overlay instance
   */
  destroy() {
    // Stop render loop
    this._stopLoop();

    // Unbind event listeners
    this._unbindListeners();

    // Remove canvas from DOM
    if (this.canvas && this.canvas.parentNode) {
      this.canvas.parentNode.removeChild(this.canvas);
    }

    // Clean up references
    this.canvas = null;
    this.ctx = null;
    this.frameData = null;
    this.activeFrameId = null;
    this.renderer = null;
    this.enabled = false;
    this.ready = false;

    this.player.debug.log('Overlay destroyed');
  }
}

export default Overlay;
