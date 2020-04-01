//
// The player script observes the contents of the page for media elements to
// remotely control. Information regarding the media is sent to the host
// application to determine how playback should be handled. Certain playback
// events are also sent to the page such as play, pause, seek, and volume.
//

;(function() {
  console.debug(`Metastream player content script ${location.href}`)

  //=============================================================================
  // Setup communications between content script and background script.
  //=============================================================================

  // Listen for events from the main world to forward to the
  // background process
  const eventMiddleware = event => {
    if (event.origin !== location.origin) return
    const { data: action } = event
    if (typeof action !== 'object' || typeof action.type !== 'string') return
    if (action.type.startsWith('metastream-')) {
      // Send to background script
      chrome.runtime.sendMessage(action)
    }
  }
  window.addEventListener('message', eventMiddleware)

  // Forward host events to main world
  chrome.runtime.onMessage.addListener(action => {
    if (typeof action !== 'object' || typeof action.type !== 'string') return
    if (action.type === 'metastream-host-event') {
      window.postMessage(action.payload, location.origin)
      return
    }
  })

  //=============================================================================
  // Improve visuals of image or video pages
  //=============================================================================

  const body = document.body

  function enhanceVideo(video) {
    Object.assign(video, {
      loop: false,
      controls: false
    })

    Object.assign(video.style, {
      minWidth: '100%',
      minHeight: '100%'
    })
  }

  function enhanceImage(image) {
    const { src } = image

    // Assume extension is correct because we can't get the MIME type
    const isGif = src.endsWith('gif')

    Object.assign(image.style, {
      width: '100%',
      height: '100%',
      objectFit: 'contain',
      background: null,
      cursor: null,
      webkitUserDrag: 'none'
    })

    // Create new image which doesn't inherit any default zoom behavior
    const img = image.cloneNode(true)
    body.replaceChild(img, image)

    if (!isGif) {
      let bg = document.createElement('div')
      Object.assign(bg.style, {
        backgroundImage: `url(${src})`,
        backgroundSize: 'cover',
        backgroundPosition: '50% 50%',
        position: 'fixed',
        top: 0,
        left: 0,
        width: '100%',
        height: '100%',
        zIndex: '-1',
        filter: 'blur(20px) brightness(0.66)',
        transform: 'scale(1.2)'
      })
      body.insertBefore(bg, body.firstChild)
    }
  }

  if (body && body.childElementCount === 1) {
    const video = document.querySelector('body > video[autoplay]')
    if (video) {
      enhanceVideo(video)
    }

    const image = document.querySelector('body > img')
    if (image) {
      enhanceImage(image)
    }
  }

  //=============================================================================
  // Popup player enhancements
  //=============================================================================

  window.addEventListener('DOMContentLoaded', () => {
    // only apply to top frame player, aka popup player
    if (window.top !== window.self) return

    const style = document.createElement('style')
    style.innerHTML = `body { background: #000 !important; }`
    if (document.head) {
      document.head.appendChild(style)
    }
  })

  //=============================================================================
  // Main world script - modifies media in the main browser context.
  //=============================================================================

  // Code within function will be injected into main world.
  // No closure variables are allowed within the function body.
  const mainWorldScript = function() {
    // Injected by Metastream
    console.debug(`Metastream main world script ${location.href}`)

    //===========================================================================
    // Globals
    //===========================================================================

    function debounce(func, wait, immediate) {
      var timeout
      return function() {
        var context = this,
          args = arguments
        var later = function() {
          timeout = null
          if (!immediate) func.apply(context, args)
        }
        var callNow = immediate && !timeout
        clearTimeout(timeout)
        timeout = setTimeout(later, wait)
        if (callNow) func.apply(context, args)
      }
    }

    function throttle(func, wait, options) {
      var context, args, result
      var timeout = null
      var previous = 0
      if (!options) options = {}
      var later = function() {
        previous = options.leading === false ? 0 : Date.now()
        timeout = null
        result = func.apply(context, args)
        if (!timeout) context = args = null
      }
      return function() {
        var now = Date.now()
        if (!previous && options.leading === false) previous = now
        var remaining = wait - (now - previous)
        context = this
        args = arguments
        if (remaining <= 0 || remaining > wait) {
          if (timeout) {
            clearTimeout(timeout)
            timeout = null
          }
          previous = now
          result = func.apply(context, args)
          if (!timeout) context = args = null
        } else if (!timeout && options.trailing !== false) {
          timeout = setTimeout(later, remaining)
        }
        return result
      }
    }

    /** https://developer.mozilla.org/en-US/docs/Web/API/HTMLMediaElement/readyState */
    const MediaReadyState = {
      HAVE_NOTHING: 0,
      HAVE_METADATA: 1,
      HAVE_CURRENT_DATA: 2,
      HAVE_FUTURE_DATA: 3,
      HAVE_ENOUGH_DATA: 4
    }

    const PlaybackState = {
      Idle: 0,
      Playing: 1,
      Paused: 2
    }

    const SEC2MS = 1000
    const MS2SEC = 1 / 1000

    const noop = () => {}

    const mediaList = new Set()
    let player
    let activeMedia, activeFrame
    let isInInteractMode = false

    const hasActiveMedia = () => Boolean(activeMedia || activeFrame)

    let playerSettings = {
      autoFullscreen: true,
      theaterMode: false,
      mediaSessionProxy: true,
      syncOnBuffer: true,
      seekThreshold: 100 /** Threshold before we'll seek. */,
      theaterModeSelectors: [
        '#vilosCanvas', // crunchyroll
        '#velocity-canvas', // crunchyroll
        '.libassjs-canvas', // vrv
        '.player-timedtext', // netflix
        '.ytp-caption-segment' // youtube
      ]
    }

    //===========================================================================
    // Communicate between main world and content script's isolated world.
    //===========================================================================

    // Dispatch event
    // main world -> content script world -> background -> metastream content script -> metastream app
    const dispatchMediaEvent = action => {
      window.postMessage({
        type: 'metastream-webview-event',
        payload: { type: 'message', payload: action }
      })
    }

    const eventMiddleware = event => {
      const { data: action } = event
      if (typeof action !== 'object' || typeof action.type !== 'string') return

      console.debug(`[Metastream Remote] Received player event`, action)

      switch (action.type) {
        case 'set-settings': {
          const prev = playerSettings
          playerSettings = { ...prev, ...action.payload }
          onSettingsChange(playerSettings, prev)
          break
        }
        case 'set-interact': {
          setInteractMode(!!action.payload)
          break
        }
        case 'apply-fullscreen': {
          const href = action.payload
          if (location.href === href) {
            window.parent.postMessage({ type: 'apply-fullscreen-parent' }, '*')
            startAutoFullscreen()
          }
          return
        }
        case 'apply-fullscreen-parent': {
          // Fullscreen parent frame of video content.
          // Searches for iframe src sharing same domain as event origin.
          const iframes = Array.from(document.querySelectorAll('iframe'))
          const iframe = iframes.find(({ src }) => src.length > 0 && src.includes(event.origin))
          activeFrame = iframe || undefined
          setTheaterMode(!!playerSettings.theaterMode)
          startAutoFullscreen(activeFrame)

          const isTopFrame = window.self === window.top
          if (!isTopFrame && activeFrame) {
            window.parent.postMessage({ type: 'apply-fullscreen-parent' }, '*')
          }
          return
        }
      }

      if (!player) return

      switch (action.type) {
        case 'set-media-playback': {
          if (action.payload === PlaybackState.Playing) {
            player.play()
          } else if (action.payload === PlaybackState.Paused) {
            player.pause()
          }
          break
        }
        case 'seek-media':
          player.seek(action.payload)
          break
        case 'set-media-volume':
          player.setVolume(action.payload)
          break
      }
    }
    window.addEventListener('message', eventMiddleware)

    const setInteractMode = enable => {
      isInInteractMode = enable
      setTheaterMode(playerSettings.theaterMode && !enable)
      if (enable) {
        stopAutoFullscreen()
      } else {
        startAutoFullscreen()
      }
    }

    //===========================================================================
    // Media Session proxy
    //===========================================================================

    const { mediaSession } = window.navigator

    const MediaMetadata = window.MediaMetadata || Object
    window.MediaMetadata = class MetastreamMediaMetadata extends MediaMetadata {
      constructor(metadata) {
        super(metadata)
        this._raw = metadata
      }
    }

    class MediaSessionProxy {
      constructor() {
        // inherit proxy fields from first.js
        this._metadata = null
        this._handlers = (mediaSession && { ...mediaSession._handlers }) || {}
      }

      get metadata() {
        return this._metadata
      }

      set metadata(metadata) {
        console.debug('MediaSession.metadata', metadata)
        this._metadata = metadata
        dispatchMediaEvent({
          type: 'media-metadata-change',
          payload: metadata ? metadata._raw : undefined
        })
      }

      setActionHandler(name, handler) {
        console.debug(`MediaSession.setActionHandler '${name}'`)
        this._handlers[name] = handler
      }

      execActionHandler(name, ...args) {
        if (!playerSettings.mediaSessionProxy) return false
        if (this._handlers.hasOwnProperty(name)) {
          console.debug(`MediaSession.execActionHandler '${name}'`, ...args)
          this._handlers[name](...args)
          return true
        }
        return false
      }
    }

    const mediaSessionProxy = new MediaSessionProxy()
    Object.defineProperty(window.navigator, 'mediaSession', {
      value: mediaSessionProxy,
      enumerable: false,
      writable: true
    })
    console.debug('Overwrote navigator.mediaSession')

    //===========================================================================
    // HTMLMediaPlayer class for active media element.
    //===========================================================================

    /** Abstraction around HTML video tag. */
    class HTMLMediaPlayer {
      constructor(media) {
        this.media = media

        this.onPlay = this.onPlay.bind(this)
        this.onPlayError = this.onPlayError.bind(this)
        this.onPause = this.onPause.bind(this)
        this.onEnded = this.onEnded.bind(this)
        this.onSeeked = this.onSeeked.bind(this)
        this.onVolumeChange = this.onVolumeChange.bind(this)
        this.onTimeUpdate = throttle(this.onTimeUpdate.bind(this), 1e3)
        this.onWaiting = this.onWaiting.bind(this)

        this.media.addEventListener('play', this.onPlay, false)
        this.media.addEventListener('pause', this.onPause, false)
        this.media.addEventListener('ended', this.onEnded, false)
        this.media.addEventListener('seeked', this.onSeeked, false)
        this.media.addEventListener('volumechange', this.onVolumeChange, false)
        this.media.addEventListener('timeupdate', this.onTimeUpdate, false)
      }

      destroy() {
        this.media.removeEventListener('play', this.onPlay, false)
        this.media.removeEventListener('pause', this.onPause, false)
        this.media.removeEventListener('ended', this.onEnded, false)
        this.media.removeEventListener('seeked', this.onSeeked, false)
        this.media.removeEventListener('volumechange', this.onVolumeChange, false)
        this.media.removeEventListener('timeupdate', this.onTimeUpdate, false)
        this.stopWaitingListener()
      }

      dispatch(eventName, detail) {
        const e = new CustomEvent(eventName, { detail: detail, cancelable: true, bubbles: false })
        document.dispatchEvent(e)
        return e.defaultPrevented
      }

      play() {
        if (this.dispatch('metastreamplay')) return
        if (mediaSessionProxy.execActionHandler('play')) return
        this.startWaitingListener()
        return this.media.play().catch(this.onPlayError)
      }
      pause() {
        this.stopWaitingListener()
        if (this.dispatch('metastreampause')) return
        if (mediaSessionProxy.execActionHandler('pause')) return
        this.media.pause()
      }
      getCurrentTime() {
        return this.media.currentTime * SEC2MS
      }
      getDuration() {
        return getVideoDuration(this.media)
      }
      seek(time) {
        if (this.dispatch('metastreamseek', time)) return

        if (mediaSessionProxy.execActionHandler('seekto', { seekTime: time, fastSeek: false }))
          return

        // Infinity is generally used for a dynamically allocated media object
        // or live media
        const duration = this.getDuration() * SEC2MS
        if (duration === Infinity || !isValidDuration(duration)) {
          return
        }

        // Only seek if we're off by greater than our threshold
        if (this.timeExceedsThreshold(time)) {
          this.media.currentTime = time * MS2SEC
        }
      }
      setVolume(volume) {
        // MUST SET THIS FIRST
        this.volume = volume

        this.media.volume = volume

        if (this.media.muted && volume > 0) {
          this.media.muted = false
        }
      }

      /** Only seek if we're off by greater than our threshold */
      timeExceedsThreshold(time) {
        const dt = Math.abs(time - this.getCurrentTime())
        return dt > (playerSettings.seekThreshold || 0)
      }

      onPlay() {
        // Set volume as soon as playback begins
        if (typeof this.volume === 'number') {
          this.setVolume(this.volume)
        }

        this.onPlaybackChange('playing')
      }

      onPlayError(err) {
        dispatchMediaEvent({ type: 'media-autoplay-error', payload: { error: err.name } })

        if (err.name === 'NotAllowedError') {
          // Attempt muted autoplay
          this.setVolume(0)
          this.media.play().catch(noop)
        }
      }

      onPause() {
        this.onPlaybackChange('paused')
      }

      onEnded() {
        this.onPlaybackChange('ended')
      }

      onSeeked() {
        dispatchMediaEvent({ type: 'media-seeked', payload: this.getCurrentTime() })
      }

      onTimeUpdate() {
        dispatchMediaEvent({ type: 'media-time-update', payload: this.getCurrentTime() })
      }

      /** Prevent third-party service from restoring cached volume */
      onVolumeChange() {
        const { volume } = this
        if (volume && this.media.volume !== volume) {
          console.debug(
            `[Metastream Remote] Volume changed internally (${this.media.volume}), reverting to ${volume}`
          )
          this.setVolume(volume)
        }
      }

      onPlaybackChange(state) {
        dispatchMediaEvent({
          type: 'media-playback-change',
          payload: { state: state, time: this.getCurrentTime() }
        })
      }

      startWaitingListener() {
        if (this._awaitingStart) return
        this.media.addEventListener('waiting', this.onWaiting, false)
      }

      stopWaitingListener() {
        if (this._awaitingStart) this.media.removeEventListener('waiting', this.onWaiting, false)
        if (this._endWaiting) this._endWaiting()
      }

      /** Force start playback on waiting */
      onWaiting() {
        if (!playerSettings.syncOnBuffer) return

        if (this._awaitingStart) return
        this._awaitingStart = true

        this.onPlaybackChange('buffering')

        let timeoutId = null

        const onStarted = () => {
          this.media.removeEventListener('playing', onStarted, false)
          clearTimeout(timeoutId)

          if (this.media.paused) {
            this.media.play().catch(noop)

            // HACK: Clear buffering spinner
            setTimeout(() => {
              if (!this.media.paused) {
                this.media.pause()
                this.media.play().catch(noop)
              }
            }, 1000)
          }

          this._awaitingStart = false
          this._endWaiting = null
        }
        this._endWaiting = onStarted
        this.media.addEventListener('playing', onStarted, false)

        let startTime = this.media.currentTime
        let time = startTime
        let attempt = 1

        const ATTEMPT_INTERVAL = 200
        const tryPlayback = () => {
          console.debug(
            `Attempting to force start playback [#${attempt++}][networkState=${
              this.media.networkState
            }][readyState=${this.media.readyState}]`
          )
          time += ATTEMPT_INTERVAL * MS2SEC

          const dt = Math.abs(time - startTime)
          if (dt > 1) {
            startTime = time
            this.seek(time * SEC2MS)
          } else {
            this.dispatch('metastreampause') || this.media.pause()
            const playPromise = this.dispatch('metastreamplay') || this.media.play()
            if (playPromise && playPromise.then) playPromise.catch(noop)
          }

          if (this.media.readyState === 4) {
            onStarted()
            return
          }

          timeoutId = setTimeout(tryPlayback, ATTEMPT_INTERVAL)
        }

        const initialDelay = this._hasAttemptedStart ? 200 : 1000
        timeoutId = setTimeout(tryPlayback, initialDelay)
        this._hasAttemptedStart = true
      }
    }

    //===========================================================================
    // Sync Chromecast videos
    //===========================================================================

    class CastPlayer {
      constructor(media) {
        this.media = media
        this.duration = null
        this.playerState = null
        this.currentTime = null

        this.onStatusChange = this.onStatusChange.bind(this)
        this.onPlaybackChange = this.onPlaybackChange.bind(this)
        this.onSeeked = this.onSeeked.bind(this)
        this.onReady = this.onReady.bind(this)
        this.onTimeUpdate = throttle(this.onTimeUpdate.bind(this), 1e3)

        this.media.addUpdateListener(this.onStatusChange)
      }

      play() {
        this.media.play()
      }

      pause() {
        this.media.pause()
      }

      seek(time) {
        const seekRequest = new chrome.cast.media.SeekRequest()
        seekRequest.currentTime = time * MS2SEC
        this.media.seek(seekRequest)
      }

      setVolume(volume) {
        this.media.setVolume(new chrome.cast.media.VolumeRequest(new chrome.cast.Volume(volume)))
      }

      destroy() {
        this.media.removeUpdateListener(this.onStatusChange)
      }

      onStatusChange(stillAlive) {
        if (this.media.media && this.media.media.duration && !this.duration) {
          this.duration = this.media.media.duration
          this.onReady()
        }

        if (!stillAlive || !this.playerState || this.playerState !== this.media.playerState) {
          this.playerState = this.media.playerState
          const { IDLE, PLAYING, PAUSED, BUFFERING } = chrome.cast.media.PlayerState
          if (!stillAlive) {
            this.onPlaybackChange('ended')
          } else if (this.playerState === BUFFERING) {
            this.onPlaybackChange('buffering')
          } else if (this.playerState === PLAYING) {
            this.onPlaybackChange('playing')
          } else if (this.playerState === PAUSED) {
            this.onPlaybackChange('paused')
          }
        }

        if (this.currentTime !== this.media.getEstimatedTime()) {
          this.currentTime = this.media.getEstimatedTime()
          this.onTimeUpdate()
        }
      }

      onPlaybackChange(state) {
        dispatchMediaEvent({
          type: 'media-playback-change',
          payload: { state: state, time: this.media.getEstimatedTime() * SEC2MS }
        })
      }

      onSeeked() {
        dispatchMediaEvent({
          type: 'media-seeked',
          payload: this.media.getEstimatedTime() * SEC2MS
        })
      }

      onTimeUpdate() {
        dispatchMediaEvent({
          type: 'media-time-update',
          payload: this.media.getEstimatedTime() * SEC2MS
        })
      }

      onReady() {
        dispatchMediaEvent({
          type: 'media-ready',
          payload: {
            duration: this.duration * SEC2MS,
            href: location.href
          }
        })
      }
    }

    if (chrome) {
      const interceptSet = (target, property, handler) =>
        new Proxy(target, {
          set(t, p, v) {
            if (p === property) {
              t[p] = handler(v)
            } else {
              t[p] = v
            }
            return true
          }
        })

      const interceptApplyArgs = (target, handler) =>
        new Proxy(target, {
          apply(target, thisArg, args) {
            return target.apply(thisArg, handler(args))
          }
        })

      const onNewMedia = media => {
        if (player && typeof player.destroy === 'function') player.destroy()
        player = new CastPlayer(media)
      }

      const onNewSession = session => {
        session.loadMedia = interceptApplyArgs(
          session.loadMedia,
          ([loadRequest, success, ...args]) => [
            loadRequest,
            media => {
              onNewMedia(media)
              return success(media)
            },
            ...args
          ]
        )
        if (session.media.length) {
          onNewMedia(session.media[0])
        }
        return session
      }

      const newRequestSession = oldRequestSession =>
        interceptApplyArgs(oldRequestSession, ([success, ...args]) => [
          session => success(onNewSession(session)),
          ...args
        ])

      const newInitialize = oldInitialize =>
        interceptApplyArgs(oldInitialize, ([apiConfig, ...args]) => {
          const oldListener = apiConfig.sessionListener
          apiConfig.sessionListener = session => oldListener(onNewSession(session))
          return [apiConfig, ...args]
        })

      if (!chrome.cast) {
        chrome = interceptSet(
          interceptSet(chrome, 'cast', cast => {
            if (!cast.initialize) {
              return interceptSet(cast, 'initialize', newInitialize)
            } else {
              cast.initialize = newInitialize(cast.initialize)
              return cast
            }
          }),
          'cast',
          cast => {
            if (!cast.requestSession) {
              return interceptSet(cast, 'requestSession', newRequestSession)
            } else {
              cast.requestSession = newRequestSession(cast.requestSession)
              return cast
            }
          }
        )
      } else {
        chrome.cast.requestSession = newRequestSession(chrome.cast.requestSession)
        chrome.cast.initialize = newInitialize(chrome.cast.initialize)
      }
    }

    //===========================================================================
    // Autoplay
    //===========================================================================

    const AUTOPLAY_TIMEOUT = 3000
    let autoplayTimerId

    // Popular enough player that it's worth a try
    const playJwPlayer = () => {
      if (typeof jwplayer === 'function') {
        try {
          const player = jwplayer()
          player.play()
          return true
        } catch (e) {}
      }
    }
    const playVideoJS = () => {
      if (typeof videojs === 'function') {
        try {
          const { players } = videojs
          const playerIds = Object.keys(players)
          playerIds.forEach(id => players[id].play())
          return playerIds.length > 0
        } catch (e) {}
      }
    }
    const pressStart = () => {
      const { start } = window
      if (start instanceof HTMLElement) {
        start.click()
        return true
      }
    }

    // Just maybe we can programmatically trigger playback with a fake click
    const clickPlayButton = () => {
      function descRectArea(a, b) {
        const areaA = a.width * a.height
        const areaB = b.width * b.height
        if (areaA > areaB) return -1
        if (areaA < areaB) return 1
        return 0
      }

      function elementFromCenterRect(rect) {
        return rect.width > 0 && rect.height > 0
          ? document.elementFromPoint(rect.x + rect.width / 2, rect.y + rect.height / 2)
          : null
      }

      let playButton

      const videos = Array.from(mediaList).filter(media => media instanceof HTMLVideoElement)
      if (videos.length > 0) {
        const rects = videos.map(video => video.getBoundingClientRect())
        rects.sort(descRectArea)

        // assumes largest video rect is most relevant
        playButton = elementFromCenterRect(rects[0])
      }

      if (!playButton) {
        // sometimes player is accessible via global
        const player = document.getElementById('player')
        if (player instanceof HTMLElement) {
          playButton = elementFromCenterRect(player.getBoundingClientRect())
        }
      }

      if (!playButton) {
        // try center of frame instead
        playButton = document.elementFromPoint(window.innerWidth / 2, window.innerHeight / 2)
      }

      // In case we land on an SVG element, keep traversing up
      while (playButton && !(playButton instanceof HTMLElement) && playButton.parentNode) {
        playButton = playButton.parentNode
      }

      if (playButton instanceof HTMLButtonElement || playButton instanceof HTMLDivElement) {
        console.debug('Attempting autoplay click', playButton)
        playButton.click()
      }
    }

    // Try different methods of initiating playback
    const attemptAutoplay = () => {
      if (hasActiveMedia()) return
      console.debug(`Attempting autoplay in ${location.origin}`)
      if (playJwPlayer()) return
      if (playVideoJS()) return
      if (pressStart()) return
      clickPlayButton()
    }

    const autoplayOnLoad = () => {
      if (autoplayTimerId) clearTimeout(autoplayTimerId)
      autoplayTimerId = setTimeout(attemptAutoplay, AUTOPLAY_TIMEOUT)
    }
    window.addEventListener('load', autoplayOnLoad)

    //===========================================================================
    // Auto-fullscreen
    //===========================================================================

    let isFullscreen = false
    let fullscreenElement
    let fullscreenContainer
    let fullscreenFrameId
    let origDocumentOverflow
    let prevScale = 1

    function getNormalizedRect(el, rootEl) {
      // Get renderered offsets
      const rect = el.getBoundingClientRect()
      const rootRect = rootEl.getBoundingClientRect()

      // Normalize against transform scale
      const normalize = 1 / prevScale
      const width = rect.width * normalize
      const height = rect.height * normalize
      const left = (rect.left - rootRect.left) * normalize
      const top = (rect.top - rootRect.top) * normalize

      return { width, height, left, top }
    }

    // calculate rect of video contained within video element
    function getVideoRect(video, rootEl) {
      let { width, height, left, top } = getNormalizedRect(video, rootEl)
      let { videoWidth, videoHeight } = video

      const videoContainScale = Math.min(width / videoWidth, height / videoHeight)
      videoWidth *= videoContainScale
      videoHeight *= videoContainScale

      const deltaWidth = width - videoWidth
      const deltaHeight = height - videoHeight

      return {
        width: width - deltaWidth,
        height: height - deltaHeight,
        left: left + deltaWidth / 2,
        top: top + deltaHeight / 2
      }
    }

    // Fit media within viewport
    function renderFullscreen() {
      document.body.style.setProperty('overflow', 'hidden', 'important')

      const { innerWidth: viewportWidth, innerHeight: viewportHeight } = window
      const { width, height, left, top } =
        fullscreenElement instanceof HTMLVideoElement
          ? getVideoRect(fullscreenElement, fullscreenContainer)
          : getNormalizedRect(fullscreenElement, fullscreenContainer)

      let transform, transformOrigin, scale

      // Approximate whether the video already fills the viewport
      const videoFillsViewport =
        Math.abs(width - viewportWidth) < 20 && Math.abs(height - viewportHeight) < 20

      if (videoFillsViewport) {
        transform = ''
        transformOrigin = ''
        scale = 1
      } else {
        // Set transform origin on video center
        const vidCenterX = left + width / 2
        const vidCenterY = top + height / 2
        transformOrigin = `${vidCenterX}px ${vidCenterY}px`

        // Transform video to center of viewport
        const viewportCenterX = viewportWidth / 2
        const viewportCenterY = viewportHeight / 2
        const offsetX = -1 * (vidCenterX - viewportCenterX)
        const offsetY = -1 * (vidCenterY - viewportCenterY)
        transform = `translate(${offsetX}px, ${offsetY}px)`

        // Scale to fit viewport
        const scaleWidth = viewportWidth / width
        const scaleHeight = viewportHeight / height
        scale = scaleWidth > scaleHeight ? scaleHeight : scaleWidth
        transform += ` scale(${scale})`
      }

      fullscreenContainer.style.transformOrigin = transformOrigin
      fullscreenContainer.style.transform = transform
      prevScale = (isFinite(scale) && scale) || 1

      fullscreenFrameId = requestAnimationFrame(renderFullscreen)
    }

    function startAutoFullscreen(target = activeMedia || activeFrame) {
      if (!(target instanceof HTMLVideoElement || target instanceof HTMLIFrameElement)) return
      if (isInInteractMode) return

      if (isFullscreen) stopAutoFullscreen()
      isFullscreen = true

      console.debug('Starting autofullscreen', target)

      // Prevent scroll offset
      if ('scrollRestoration' in history) {
        history.scrollRestoration = 'manual'
      }
      window.scrollTo(0, 0) // reset scroll
      origDocumentOverflow = getComputedStyle(document.body).overflow

      // Find container we can transform
      let container = (fullscreenContainer = target)
      do {
        if (container instanceof HTMLElement && container.offsetWidth && container.offsetHeight) {
          fullscreenContainer = container
        }
      } while ((container = container.parentNode))

      // If fullscreen container is not at the top left of the viewport, revert
      // to document.
      if (fullscreenContainer && fullscreenContainer.getBoundingClientRect().left > 0) {
        fullscreenContainer = document.documentElement
      }

      fullscreenElement = target

      if (playerSettings.autoFullscreen) {
        fullscreenFrameId = requestAnimationFrame(renderFullscreen)
      }
    }

    function stopAutoFullscreen() {
      console.debug('Stopping autofullscreen')
      isFullscreen = false
      fullscreenElement = undefined
      if (origDocumentOverflow) {
        document.body.style.overflow = origDocumentOverflow
        origDocumentOverflow = undefined
      }
      if (fullscreenFrameId) {
        cancelAnimationFrame(fullscreenFrameId)
        fullscreenFrameId = undefined
      }
      if (fullscreenContainer) {
        fullscreenContainer.style.transform = ''
        fullscreenContainer.style.transformOrigin = ''
        fullscreenContainer = undefined
      }
    }

    //===========================================================================
    // Theater Mode
    //===========================================================================

    let theaterModeStyle

    // Creates styles to hide all non-video elements in the document
    function getFocusStyles(visibleTagName, selectors) {
      const ignoredSelectors = [visibleTagName, ...selectors]
        .map(selector => `:not(${selector})`)
        .join('')

      // :not(:empty) used to boost specificity
      return `
${ignoredSelectors}:not(:empty),
${ignoredSelectors}:not(:empty):after,
${ignoredSelectors}:not(:empty):before {
  color: transparent !important;
  z-index: 0;
  background: transparent !important;
  border-color: transparent !important;
  outline: none !important;
  box-shadow: none !important;
  text-shadow: none !important;
  mix-blend-mode: normal !important;
  filter: none !important;
  fill: none !important;
  stroke: none !important;
  -webkit-text-stroke: transparent !important;
  -webkit-mask: none !important;
  transition: none !important;
}

${ignoredSelectors}:empty {
  visibility: hidden !important;
}`
    }

    function setTheaterMode(enable) {
      if (theaterModeStyle) {
        theaterModeStyle.remove()
        theaterModeStyle = undefined
      }

      if (!enable) return

      const target = activeFrame || activeMedia

      // don't hide UI if target is audio
      if (target instanceof HTMLAudioElement) return

      // don't hide UI if target not in DOM
      if (target instanceof HTMLElement && !target.parentNode) return

      const visibleTagName = target instanceof HTMLVideoElement ? 'video' : 'iframe'
      const style = document.createElement('style')
      style.innerHTML = getFocusStyles(visibleTagName, playerSettings.theaterModeSelectors)
      theaterModeStyle = style
      document.head.appendChild(theaterModeStyle)
    }

    //===========================================================================
    // Track the active/primary media element
    //===========================================================================

    const MIN_DURATION = 1
    const MAX_DURATION = 60 * 60 * 20 * SEC2MS
    const isValidDuration = duration =>
      typeof duration === 'number' &&
      !isNaN(duration) &&
      duration < MAX_DURATION &&
      duration > MIN_DURATION

    const getVideoDuration = mediaElement => {
      let duration

      if (mediaElement instanceof HTMLMediaElement) {
        duration = mediaElement.duration
        if (isValidDuration(duration)) return duration
      }

      // attempt to get duration from global 'player'
      const { player } = window
      if (typeof player === 'object' && typeof player.getDuration === 'function') {
        try {
          duration = player.getDuration()
        } catch (e) {}
        if (isValidDuration(duration)) return duration
      }

      return null
    }

    let prevDuration
    const signalReady = mediaElement => {
      const duration = getVideoDuration(mediaElement)
      if (prevDuration === duration) return

      dispatchMediaEvent({
        type: 'media-ready',
        payload: {
          duration: duration ? duration * SEC2MS : undefined,
          href: location.href
        }
      })

      prevDuration = duration
    }

    const setActiveMedia = media => {
      activeMedia = media
      activeFrame = undefined

      if (player) player.destroy()
      player = new HTMLMediaPlayer(media)

      console.debug('Set active media', media, media.src, media.duration)
      window.MEDIA = media

      if (autoplayTimerId) {
        clearTimeout(autoplayTimerId)
        autoplayTimerId = undefined
      }

      prevDuration = undefined

      startAutoFullscreen()

      // TODO: Use MutationObserver to observe if video gets removed from DOM

      const onDurationChange = debounce(signalReady, 2000, media)
      media.addEventListener('durationchange', onDurationChange, false)
      signalReady(media)
    }

    const addMedia = media => {
      if (mediaList.has(media)) {
        return
      }

      console.debug('Add media', media, media.src, media.duration)
      mediaList.add(media)

      // Immediately mute to prevent being really loud
      media.volume = 0

      // Checks for media when it starts playing
      function checkMediaReady() {
        if (isNaN(media.duration)) {
          return false
        }

        // Wait for videos to appear in the DOM
        if (media instanceof HTMLVideoElement && !media.parentElement) {
          return false
        }

        if (media.readyState >= MediaReadyState.HAVE_CURRENT_DATA) {
          if (!player instanceof CastPlayer) {
            setActiveMedia(media)
          }
          media.removeEventListener('playing', checkMediaReady)
          media.removeEventListener('durationchange', checkMediaReady)
          media.removeEventListener('canplay', checkMediaReady)
          return true
        }

        return false
      }

      if (media.paused || !checkMediaReady()) {
        media.addEventListener('playing', checkMediaReady)
        media.addEventListener('durationchange', checkMediaReady)
        media.addEventListener('canplay', checkMediaReady)

        clearTimeout(autoplayTimerId)
        autoplayTimerId = setTimeout(attemptAutoplay, AUTOPLAY_TIMEOUT)
      }
    }

    //===========================================================================
    // Settings
    //===========================================================================

    const onSettingsChange = (settings, prev) => {
      setTheaterMode(!!settings.theaterMode)
      if (settings.autoFullscreen && !isFullscreen) {
        startAutoFullscreen()
      } else if (!settings.autoFullscreen && isFullscreen) {
        stopAutoFullscreen()
      }
    }

    //===========================================================================
    // Observe media elements on the page
    //===========================================================================

    const listenForMedia = event => {
      const { target } = event
      if (target instanceof HTMLMediaElement) {
        addMedia(target)
      }
    }
    document.addEventListener('play', listenForMedia, true)
    document.addEventListener('durationchange', listenForMedia, true)

    // Proxy document.createElement to trap media elements created in-memory
    const origCreateElement = document.createElement
    const proxyCreateElement = function() {
      const element = origCreateElement.apply(document, arguments)
      if (element instanceof HTMLMediaElement) {
        // Wait for attributes to be set
        setTimeout(addMedia, 0, element)
      }
      return element
    }
    proxyCreateElement.toString = origCreateElement.toString.bind(origCreateElement)
    document.createElement = proxyCreateElement

    // Process media elements from first.js
    const mediaElements = window.__metastreamMediaElements
    if (mediaElements) {
      Array.from(mediaElements).forEach(addMedia)
      window.__metastreamMediaElements = undefined
    }
  }

  // Inject inline script at top of DOM to execute as soon as possible
  const script = document.createElement('script')
  script.textContent = `(${mainWorldScript}());`
  if (document.head) {
    const { firstChild } = document.head
    if (firstChild) {
      document.head.insertBefore(script, firstChild)
    } else {
      document.head.appendChild(script)
    }
  } else {
    const id = setInterval(() => {
      try {
        document.documentElement.appendChild(script)
        clearInterval(id)
      } catch (e) {}
    }, 10)
  }
})()

// Don't serialize result
void 0
