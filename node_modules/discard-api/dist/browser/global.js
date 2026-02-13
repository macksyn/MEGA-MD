"use strict";
var DiscardAPI = (() => {
  var __defProp = Object.defineProperty;
  var __getOwnPropDesc = Object.getOwnPropertyDescriptor;
  var __getOwnPropNames = Object.getOwnPropertyNames;
  var __hasOwnProp = Object.prototype.hasOwnProperty;
  var __export = (target, all) => {
    for (var name in all)
      __defProp(target, name, { get: all[name], enumerable: true });
  };
  var __copyProps = (to, from, except, desc) => {
    if (from && typeof from === "object" || typeof from === "function") {
      for (let key of __getOwnPropNames(from))
        if (!__hasOwnProp.call(to, key) && key !== except)
          __defProp(to, key, { get: () => from[key], enumerable: !(desc = __getOwnPropDesc(from, key)) || desc.enumerable });
    }
    return to;
  };
  var __toCommonJS = (mod) => __copyProps(__defProp({}, "__esModule", { value: true }), mod);

  // src/index.ts
  var index_exports = {};
  __export(index_exports, {
    DiscardAPI: () => DiscardAPI,
    default: () => index_default
  });
  var DiscardAPI = class {
    constructor(config) {
      if (!config.apiKey) {
        throw new Error("API key is required");
      }
      this.apiKey = config.apiKey;
      this.baseURL = config.baseURL || "https://discardapi.dpdns.org";
      this.fullResponse = config.fullResponse ?? false;
      this.timeout = config.timeout || 3e4;
    }
    buildURL(endpoint, params) {
      const url = new URL(`${this.baseURL}${endpoint}`);
      const allParams = { ...params, apikey: this.apiKey };
      Object.entries(allParams).forEach(([key, value]) => {
        if (value !== void 0 && value !== null) {
          url.searchParams.append(key, String(value));
        }
      });
      return url.toString();
    }
    async request(endpoint, method = "GET", params, body, apiKeyLocation = "query") {
      let url;
      const controller = new AbortController();
      const timeoutId = setTimeout(() => controller.abort(), this.timeout);
      try {
        const fetchOptions = {
          method,
          signal: controller.signal,
          headers: {}
        };
        if (method === "GET") {
          url = this.buildURL(endpoint, params || {});
        } else {
          url = apiKeyLocation === "query" ? this.buildURL(endpoint, params || {}) : `${this.baseURL}${endpoint}`;
          if (body) {
            if (body instanceof FormData) {
              if (apiKeyLocation === "body") {
                body.append("apikey", this.apiKey);
              }
              fetchOptions.body = body;
            } else {
              fetchOptions.headers = { "Content-Type": "application/json" };
              const bodyData = apiKeyLocation === "body" ? { ...body, apikey: this.apiKey } : body;
              fetchOptions.body = JSON.stringify(bodyData);
            }
          }
        }
        const response = await fetch(url, fetchOptions);
        if (!response.ok) {
          throw new Error(`HTTP error! status: ${response.status}`);
        }
        const contentType = response.headers.get("content-type");
        if (contentType?.includes("application/json")) {
          const data = await response.json();
          return this.fullResponse ? data : data.result ?? data;
        }
        return response.text();
      } catch (error) {
        if (error instanceof Error && error.name === "AbortError") {
          throw new Error("Request timeout");
        }
        throw error;
      } finally {
        clearTimeout(timeoutId);
      }
    }
    // ==================== ISLAMIC ====================
    quranSurah(params) {
      return this.request("/api/dl/surah", "GET", params);
    }
    hadith(params) {
      return this.request("/api/get/hadith", "GET", params);
    }
    prayerTiming(params) {
      return this.request("/api/prayer/timing", "GET", params);
    }
    quran(params) {
      return this.request("/api/islamic/quran", "GET", params);
    }
    islamicHadit(params) {
      return this.request("/api/islamic/hadit", "GET", params);
    }
    tahlil() {
      return this.request("/api/islamic/tahlil", "GET");
    }
    wirid() {
      return this.request("/api/islamic/wirid", "GET");
    }
    dua() {
      return this.request("/api/islamic/dua", "GET");
    }
    ayatkursi() {
      return this.request("/api/islamic/ayatkursi", "GET");
    }
    searchBooks() {
      return this.request("/api/get/books", "GET");
    }
    getBooks(params) {
      return this.request("/api/get/books", "GET", params);
    }
    // ==================== AI ====================
    geminiPro(params) {
      return this.request("/api/gemini/pro", "GET", params);
    }
    geminiFlash(params) {
      return this.request("/api/gemini/flash", "GET", params);
    }
    googleGemma(params) {
      return this.request("/api/gemini/gemma", "GET", params);
    }
    geminiEmbed(params) {
      return this.request("/api/gemini/embed", "GET", params);
    }
    llamaAI(params) {
      return this.request("/api/ai/llama", "GET", params);
    }
    mythomax(params) {
      return this.request("/api/ai/mythomax", "GET", params);
    }
    mistralAI(params) {
      return this.request("/api/ai/mistral", "GET", params);
    }
    qwenCoder(params) {
      return this.request("/api/ai/qwen", "GET", params);
    }
    kimiAI(params) {
      return this.request("/api/ai/kimi", "GET", params);
    }
    gemmaAI(params) {
      return this.request("/api/ai/gemma", "GET", params);
    }
    fluxSchnell(params) {
      return this.request("/api/imagen/schnell", "GET", params);
    }
    fluxDev(params) {
      return this.request("/api/imagen/flux", "GET", params);
    }
    stableDiffusion(params) {
      return this.request("/api/imagen/diffusion", "GET", params);
    }
    blackForest(params) {
      return this.request("/api/imagen/sdxlb", "GET", params);
    }
    dallE(params) {
      return this.request("/api/imagen/dalle", "GET", params);
    }
    // ==================== ANIME ====================
    animeNom() {
      return this.request("/api/anime/nom", "GET");
    }
    animePoke() {
      return this.request("/api/anime/poke", "GET");
    }
    animeCry() {
      return this.request("/api/anime/cry", "GET");
    }
    animeKiss() {
      return this.request("/api/anime/kiss", "GET");
    }
    animePat() {
      return this.request("/api/anime/pat", "GET");
    }
    animeHug() {
      return this.request("/api/anime/hug", "GET");
    }
    animeWink() {
      return this.request("/api/anime/wink", "GET");
    }
    animeFace() {
      return this.request("/api/anime/face", "GET");
    }
    // ==================== APPS ====================
    searchAndroid1(params) {
      return this.request("/api/apk/search/android1", "GET", params);
    }
    dlAndroid1(params) {
      return this.request("/api/apk/dl/android1", "GET", params);
    }
    searchAppStore(params) {
      return this.request("/api/apk/search/appstore", "GET", params);
    }
    searchApkMirror(params) {
      return this.request("/api/apk/search/apkmirror", "GET", params);
    }
    dlApkMirror(params) {
      return this.request("/api/apk/dl/apkmirror", "GET", params);
    }
    searchApkPure(params) {
      return this.request("/api/apk/search/apkpure", "GET", params);
    }
    dlApkPure(params) {
      return this.request("/api/apk/dl/apkpure", "GET", params);
    }
    searchModCombo(params) {
      return this.request("/api/apk/search/modcombo", "GET", params);
    }
    searchPlayStore(params) {
      return this.request("/api/apk/search/playstore", "GET", params);
    }
    dlPlayStore(params) {
      return this.request("/api/apk/dl/playstore", "GET", params);
    }
    searchRexdl(params) {
      return this.request("/api/apk/search/rexdl", "GET", params);
    }
    dlRexdl(params) {
      return this.request("/api/apk/dl/rexdl", "GET", params);
    }
    searchSteam(params) {
      return this.request("/api/apk/search/steam", "GET", params);
    }
    searchHappyMod(params) {
      return this.request("/api/apk/search/happymod", "GET", params);
    }
    searchSFile(params) {
      return this.request("/api/apk/search/sfile", "GET", params);
    }
    // ==================== CHATBOTS ====================
    llamaBot(params) {
      return this.request("/api/bot/llama", "GET", params);
    }
    qwenBot(params) {
      return this.request("/api/bot/qwen", "GET", params);
    }
    baiduBot(params) {
      return this.request("/api/bot/baidu", "GET", params);
    }
    gemmaBot(params) {
      return this.request("/api/bot/gemma", "GET", params);
    }
    sparkBot(params) {
      return this.request("/api/chat/spark", "GET", params);
    }
    quarkBot(params) {
      return this.request("/api/chat/quark", "GET", params);
    }
    glmBot(params) {
      return this.request("/api/chat/glm", "GET", params);
    }
    // ==================== CANVAS ====================
    canvasCircle(params) {
      return this.request("/api/canvas/circle", "GET", params);
    }
    canvasBisexual(params) {
      return this.request("/api/canvas/bisexual", "GET", params);
    }
    canvasHeart(params) {
      return this.request("/api/canvas/heart", "GET", params);
    }
    canvasHorny(params) {
      return this.request("/api/canvas/horny", "GET", params);
    }
    canvasPansexual(params) {
      return this.request("/api/canvas/pansexual", "GET", params);
    }
    canvasLesbian(params) {
      return this.request("/api/canvas/lesbian", "GET", params);
    }
    canvasLGBT(params) {
      return this.request("/api/canvas/lgbtq", "GET", params);
    }
    canvasNoBinary(params) {
      return this.request("/api/canvas/nobin", "GET", params);
    }
    canvasTransgen(params) {
      return this.request("/api/canvas/transgen", "GET", params);
    }
    canvasTonikawa(params) {
      return this.request("/api/canvas/tonikawa", "GET", params);
    }
    canvasSimpcard(params) {
      return this.request("/api/canvas/simpcard", "GET", params);
    }
    // ==================== CODEC ====================
    base64(params) {
      return this.request("/api/tools/base64", "GET", params);
    }
    base32(params) {
      return this.request("/api/tools/base32", "GET", params);
    }
    base16(params) {
      return this.request("/api/tools/base16", "GET", params);
    }
    base36(params) {
      return this.request("/api/tools/base36", "GET", params);
    }
    base45(params) {
      return this.request("/api/tools/base45", "GET", params);
    }
    base58(params) {
      return this.request("/api/tools/base58", "GET", params);
    }
    base62(params) {
      return this.request("/api/tools/base62", "GET", params);
    }
    base85(params) {
      return this.request("/api/tools/base85", "GET", params);
    }
    base91(params) {
      return this.request("/api/tools/base91", "GET", params);
    }
    binary(params) {
      return this.request("/api/tools/binary", "GET", params);
    }
    brainfuck(params) {
      return this.request("/api/tools/brainfuck", "GET", params);
    }
    interpreter(params) {
      return this.request("/api/interpreter", "GET", params);
    }
    // ==================== URL SHORTENER ====================
    shortenIsgd(params) {
      return this.request("/api/short/isgd", "GET", params);
    }
    shortenL8nu(params) {
      return this.request("/api/short/l8nu", "GET", params);
    }
    shortenReurl(params) {
      return this.request("/api/short/reurl", "GET", params);
    }
    shortenTinycc(params) {
      return this.request("/api/short/tinycc", "GET", params);
    }
    shortenClck(params) {
      return this.request("/api/short/clck", "GET", params);
    }
    shortenItsl(params) {
      return this.request("/api/short/itsl", "GET", params);
    }
    shortenCuqin(params) {
      return this.request("/api/short/cuqin", "GET", params);
    }
    shortenSurl(params) {
      return this.request("/api/short/surl", "GET", params);
    }
    shortenVurl(params) {
      return this.request("/api/short/vurl", "GET", params);
    }
    shortenVgd(params) {
      return this.request("/api/short/vgd", "GET", params);
    }
    shortenClean(params) {
      return this.request("/api/short/clean", "GET", params);
    }
    shortenBitly(params) {
      return this.request("/api/short/bitly", "GET", params);
    }
    shortenTiny(params) {
      return this.request("/api/short/tiny", "GET", params);
    }
    unshort(params) {
      return this.request("/api/short/unshort", "GET", params);
    }
    // ==================== AUDIODB ====================
    audiodbScanArtist(params) {
      return this.request("/api/audiodb/scan", "GET", params);
    }
    audiodbSearchTrack(params) {
      return this.request("/api/audiodb/track", "GET", params);
    }
    audiodbDiscography(params) {
      return this.request("/api/audiodb/discography", "GET", params);
    }
    audiodbAlbums(params) {
      return this.request("/api/audiodb/albums", "GET", params);
    }
    audiodbSpecificAlbum(params) {
      return this.request("/api/audiodb/album", "GET", params);
    }
    audiodbArtistById(params) {
      return this.request("/api/audiodb/artist", "GET", params);
    }
    audiodbArtistByMbid(params) {
      return this.request("/api/audiodb/artist-mb", "GET", params);
    }
    audiodbArtistLinks(params) {
      return this.request("/api/audiodb/artist-links", "GET", params);
    }
    audiodbAlbumById(params) {
      return this.request("/api/audiodb/album-id", "GET", params);
    }
    audiodbAlbumByMbid(params) {
      return this.request("/api/audiodb/album-mb", "GET", params);
    }
    audiodbTrackByAlbumId(params) {
      return this.request("/api/audiodb/track-album", "GET", params);
    }
    audiodbTrackById(params) {
      return this.request("/api/audiodb/track-id", "GET", params);
    }
    audiodbTrackByMbid(params) {
      return this.request("/api/audiodb/track-mb", "GET", params);
    }
    audiodbVideosById(params) {
      return this.request("/api/audiodb/mvid", "GET", params);
    }
    audiodbVideosByMbid(params) {
      return this.request("/api/audiodb/mvid-mb", "GET", params);
    }
    audiodbTrendingAlbums(params) {
      return this.request("/api/audiodb/trending-albums", "GET", params);
    }
    audiodbTrendingSingles(params) {
      return this.request("/api/audiodb/trending-singles", "GET", params);
    }
    audiodbTopTracks(params) {
      return this.request("/api/audiodb/top-tracks", "GET", params);
    }
    audiodbTopTracksMb(params) {
      return this.request("/api/audiodb/top-tracks-mb", "GET", params);
    }
    // ==================== QUOTES ====================
    commitMessage() {
      return this.request("/api/commit/message", "GET");
    }
    strangerQuote() {
      return this.request("/api/quote/stranger", "GET");
    }
    pickupLine() {
      return this.request("/api/quote/pickup", "GET");
    }
    whyQuestion() {
      return this.request("/api/quote/why", "GET");
    }
    randomQuote() {
      return this.request("/api/quotes/random", "GET");
    }
    techTip() {
      return this.request("/api/quote/techtips", "GET");
    }
    codingTip() {
      return this.request("/api/quote/coding", "GET");
    }
    funFact() {
      return this.request("/api/quote/funfacts", "GET");
    }
    wyrQuote() {
      return this.request("/api/quote/wyr", "GET");
    }
    motivQuote() {
      return this.request("/api/quote/motiv", "GET");
    }
    islamicQuote() {
      return this.request("/api/quote/islamic", "GET");
    }
    lifeHack() {
      return this.request("/api/quote/lifehacks", "GET");
    }
    breakingBadQuote() {
      return this.request("/api/quote/breakingbad", "GET");
    }
    buddhaQuote() {
      return this.request("/api/quote/buddha", "GET");
    }
    stoicQuote() {
      return this.request("/api/quote/stoic", "GET");
    }
    luciferQuote() {
      return this.request("/api/quote/lucifer", "GET");
    }
    // ==================== DOWNLOADS ====================
    dlFacebook(params) {
      return this.request("/api/dl/facebook", "GET", params);
    }
    dlGitClone(params) {
      return this.request("/api/dl/gitclone", "GET", params);
    }
    dlInstagram(params) {
      return this.request("/api/dl/instagram", "GET", params);
    }
    dlMediafire(params) {
      return this.request("/api/dl/mediafire", "GET", params);
    }
    dlPinterest(params) {
      return this.request("/api/dl/pinterest", "GET", params);
    }
    dlTikTok(params) {
      return this.request("/api/dl/tiktok", "GET", params);
    }
    dlTwitter(params) {
      return this.request("/api/dl/twitter", "GET", params);
    }
    dlLikee(params) {
      return this.request("/api/dl/likee", "GET", params);
    }
    dlThreads(params) {
      return this.request("/api/dl/threads", "GET", params);
    }
    dlTwitch(params) {
      return this.request("/api/dl/twitch", "GET", params);
    }
    dlWallBest(params) {
      return this.request("/api/dl/wallbest", "GET", params);
    }
    dlWallCraft(params) {
      return this.request("/api/dl/wallcraft", "GET", params);
    }
    dlWallHaven(params) {
      return this.request("/api/dl/wallhaven", "GET", params);
    }
    dlWikimedia(params) {
      return this.request("/api/dl/wikimedia", "GET", params);
    }
    dlYouTube(params) {
      return this.request("/api/dl/youtube", "GET", params);
    }
    dlBilibili(params) {
      return this.request("/api/dl/bilibili", "GET", params);
    }
    dlLinkedIn(params) {
      return this.request("/api/dl/linkedin", "GET", params);
    }
    dlSnapChat(params) {
      return this.request("/api/dl/snapchat", "GET", params);
    }
    dlShareChat(params) {
      return this.request("/api/dl/sharechat", "GET", params);
    }
    dlSnackVideo(params) {
      return this.request("/api/dl/snack", "GET", params);
    }
    dlPinterestVideo(params) {
      return this.request("/api/dl/pinterest", "GET", params);
    }
    dlRedditVideo(params) {
      return this.request("/api/dl/reddit", "GET", params);
    }
    dlVideezy(params) {
      return this.request("/api/dl/videezy", "GET", params);
    }
    dlVidsPlay(params) {
      return this.request("/api/dl/vidsplay", "GET", params);
    }
    dlIMDbVideo(params) {
      return this.request("/api/dl/imdb", "GET", params);
    }
    dlIFunny(params) {
      return this.request("/api/dl/ifunny", "GET", params);
    }
    dlGetty(params) {
      return this.request("/api/dl/getty", "GET", params);
    }
    pexelsVideos(params) {
      return this.request("/api/pexels/videos", "GET", params);
    }
    pexelsImages(params) {
      return this.request("/api/pexels/images", "GET", params);
    }
    loremPicsum(params) {
      return this.request("/api/dl/picsum", "GET", params);
    }
    iconFinder(params) {
      return this.request("/api/icon/finder", "GET", params);
    }
    pixabayImages(params) {
      return this.request("/api/pixabay/images", "GET", params);
    }
    pixabayVideos(params) {
      return this.request("/api/pixabay/videos", "GET", params);
    }
    tenorGifs(params) {
      return this.request("/api/dl/tenor", "GET", params);
    }
    pasteBin(params) {
      return this.request("/api/dl/pastebin", "GET", params);
    }
    googleImage(params) {
      return this.request("/api/dl/gimage", "GET", params);
    }
    baiduImage(params) {
      return this.request("/api/img/baidu", "GET", params);
    }
    dailyBing() {
      return this.request("/api/img/dailybing", "GET");
    }
    dlIStock(params) {
      return this.request("/api/dl/istock", "GET", params);
    }
    dlOdysee(params) {
      return this.request("/api/dl/odysee", "GET", params);
    }
    dlAlamy(params) {
      return this.request("/api/dl/alamy", "GET", params);
    }
    // ==================== IMAGE MAKERS ====================
    qrCode(params) {
      return this.request("/api/maker/qrcode", "GET", params);
    }
    qrTag(params) {
      return this.request("/api/maker/qrtag", "GET", params);
    }
    textToPic(params) {
      return this.request("/api/maker/ttp", "GET", params);
    }
    designFont(params) {
      return this.request("/api/design/font", "GET", params);
    }
    captchaImage() {
      return this.request("/api/maker/captcha", "GET");
    }
    customQR(params) {
      return this.request("/api/maker/customqr", "GET", params);
    }
    textAvatar(params) {
      return this.request("/api/maker/avatar", "GET", params);
    }
    webLogo(params) {
      return this.request("/api/maker/weblogo", "GET", params);
    }
    whoWins(params) {
      return this.request("/api/maker/whowin", "GET", params);
    }
    quoted(params) {
      return this.request("/api/maker/quoted", "GET", params);
    }
    qrPro(params) {
      return this.request("/api/qr/pro", "GET", params);
    }
    img2Base64(body) {
      return this.request("/api/img2base64", "POST", void 0, body, "body");
    }
    base64ToImg(params) {
      return this.request("/api/img2base64", "GET", params);
    }
    barcode128(params) {
      return this.request("/api/barcode/code", "GET", params);
    }
    barcodeEAN(params) {
      return this.request("/api/barcode/ean", "GET", params);
    }
    barcodeQR(params) {
      return this.request("/api/barcode/qr", "GET", params);
    }
    emojiMosaic(body, params) {
      return this.request("/api/emoji/mosaic", "POST", params, body, "body");
    }
    emojiTranslate(params) {
      return this.request("/api/emoji/translate", "GET", params);
    }
    emojiReplace(params) {
      return this.request("/api/emoji/replace", "GET", params);
    }
    emojiMirror(params) {
      return this.request("/api/emoji/mirror", "GET", params);
    }
    emojiRainbow(params) {
      return this.request("/api/emoji/rainbow", "GET", params);
    }
    emojiMix(params) {
      return this.request("/api/emoji/mix", "GET", params);
    }
    carbonImage(params) {
      return this.request("/api/maker/carbon", "GET", params);
    }
    welcomeImage(params) {
      return this.request("/api/maker/welcome", "GET", params);
    }
    // ==================== MUSIC ====================
    searchSpotify(params) {
      return this.request("/api/search/spotify", "GET", params);
    }
    dlSpotify(params) {
      return this.request("/api/dl/spotify", "GET", params);
    }
    searchSoundCloud(params) {
      return this.request("/api/search/soundcloud", "GET", params);
    }
    dlSoundCloud(params) {
      return this.request("/api/dl/soundcloud", "GET", params);
    }
    lyrics(params) {
      return this.request("/api/music/lyrics", "GET", params);
    }
    ringtones(params) {
      return this.request("/api/dl/ringtone", "GET", params);
    }
    searchSound(params) {
      return this.request("/api/search/sound", "GET", params);
    }
    previewSound(params) {
      return this.request("/api/dl/sound", "GET", params);
    }
    searchDeezer(params) {
      return this.request("/api/search/deezer", "GET", params);
    }
    previewDeezer(params) {
      return this.request("/api/search/deezer", "GET", params);
    }
    searchMusicBrainz(params) {
      return this.request("/api/search/musicbrainz", "GET", params);
    }
    openWhyd(params) {
      return this.request("/api/search/openwhyd", "GET", params);
    }
    // ==================== JOKES ====================
    dadJoke() {
      return this.request("/api/joke/dad", "GET");
    }
    generalJoke() {
      return this.request("/api/joke/general", "GET");
    }
    knockJoke() {
      return this.request("/api/joke/knock", "GET");
    }
    programmingJoke() {
      return this.request("/api/joke/programming", "GET");
    }
    miscJoke() {
      return this.request("/api/joke/misc", "GET");
    }
    codingJoke() {
      return this.request("/api/joke/coding", "GET");
    }
    spookyJoke() {
      return this.request("/api/joke/spooky", "GET");
    }
    darkJoke() {
      return this.request("/api/joke/dark", "GET");
    }
    christmasJoke() {
      return this.request("/api/joke/Christmas", "GET");
    }
    randomJoke() {
      return this.request("/api/joke/random", "GET");
    }
    animalJoke() {
      return this.request("/api/joke/animal", "GET");
    }
    careerJoke() {
      return this.request("/api/joke/career", "GET");
    }
    celebrityJoke() {
      return this.request("/api/joke/celebrity", "GET");
    }
    explicitJoke() {
      return this.request("/api/joke/explicit", "GET");
    }
    fashionJoke() {
      return this.request("/api/joke/fashion", "GET");
    }
    foodJoke() {
      return this.request("/api/joke/food", "GET");
    }
    historyJoke() {
      return this.request("/api/joke/history", "GET");
    }
    moneyJoke() {
      return this.request("/api/joke/money", "GET");
    }
    movieJoke() {
      return this.request("/api/joke/movie", "GET");
    }
    musicJoke() {
      return this.request("/api/joke/music", "GET");
    }
    scienceJoke() {
      return this.request("/api/joke/science", "GET");
    }
    sportJoke() {
      return this.request("/api/joke/sport", "GET");
    }
    travelJoke() {
      return this.request("/api/joke/travel", "GET");
    }
    // ==================== IMAGES ====================
    coupleImage() {
      return this.request("/api/img/couple", "GET");
    }
    pizzaImage() {
      return this.request("/api/images/pizza", "GET");
    }
    burgerImage() {
      return this.request("/api/images/burger", "GET");
    }
    dosaImage() {
      return this.request("/api/images/dosa", "GET");
    }
    pastaImage() {
      return this.request("/api/images/pasta", "GET");
    }
    biryaniImage() {
      return this.request("/api/images/biryani", "GET");
    }
    islamicImage() {
      return this.request("/api/img/islamic", "GET");
    }
    techImage() {
      return this.request("/api/img/tech", "GET");
    }
    gameImage() {
      return this.request("/api/img/game", "GET");
    }
    mountainImage() {
      return this.request("/api/img/mountain", "GET");
    }
    programmingImage() {
      return this.request("/api/img/programming", "GET");
    }
    cyberSpaceImage() {
      return this.request("/api/img/cyberspace", "GET");
    }
    wallPcImage() {
      return this.request("/api/img/wallpc", "GET");
    }
    messiImage() {
      return this.request("/api/img/messi", "GET");
    }
    ronaldoImage() {
      return this.request("/api/img/ronaldo", "GET");
    }
    coffeeImage() {
      return this.request("/api/img/coffee", "GET");
    }
    catImage() {
      return this.request("/api/img/cat", "GET");
    }
    dogImage() {
      return this.request("/api/img/dog", "GET");
    }
    yesNoImage() {
      return this.request("/api/img/yesno", "GET");
    }
    foxImage() {
      return this.request("/api/img/fox", "GET");
    }
    notExistImage() {
      return this.request("/api/img/notexist", "GET");
    }
    // ==================== FACTS ====================
    dateFact(params) {
      return params?.month && params?.day ? this.request("/api/fact/date", "GET", params) : this.request("/api/date/fact", "GET");
    }
    yearFact(params) {
      return params?.year ? this.request("/api/fact/year", "GET", params) : this.request("/api/year/fact", "GET");
    }
    mathFact(params) {
      return params?.number ? this.request("/api/fact/math", "GET", params) : this.request("/api/math/fact", "GET");
    }
    triviaFact(params) {
      return params?.number ? this.request("/api/fact/trivia", "GET", params) : this.request("/api/trivia/fact", "GET");
    }
    uselessFact() {
      return this.request("/api/fact/useless", "GET");
    }
    todayFact() {
      return this.request("/api/fact/today", "GET");
    }
    // ==================== FAKER ====================
    fakeUser() {
      return this.request("/api/fake/user", "GET");
    }
    fakeUsers(params) {
      return this.request("/api/fake/users", "GET", params);
    }
    fakeAddresses(params) {
      return this.request("/api/fake/addresses", "GET", params);
    }
    fakeTexts(params) {
      return this.request("/api/fake/texts", "GET", params);
    }
    fakePersons(params) {
      return this.request("/api/fake/persons", "GET", params);
    }
    fakeBooks(params) {
      return this.request("/api/fake/books", "GET", params);
    }
    fakeImages(params) {
      return this.request("/api/fake/images", "GET", params);
    }
    fakeCredits(params) {
      return this.request("/api/fake/credits", "GET", params);
    }
    fakeCompanies(params) {
      return this.request("/api/fake/companies", "GET", params);
    }
    fakePlaces(params) {
      return this.request("/api/fake/places", "GET", params);
    }
    fakeProducts(params) {
      return this.request("/api/fake/products", "GET", params);
    }
    // ==================== FAKE STORE ====================
    storeAddProduct(body) {
      return this.request("/api/store/add/products", "POST", void 0, body, "body");
    }
    storeDeleteProduct(params) {
      return this.request("/api/store/products", "DELETE", params, void 0, "body");
    }
    storeUpdateProduct(params, body) {
      return this.request("/api/store/products", "PUT", params, body, "body");
    }
    storeAllProducts() {
      return this.request("/api/store/products", "GET");
    }
    storeGetProduct(params) {
      return this.request("/api/store/product", "GET", params);
    }
    storeAllCarts() {
      return this.request("/api/store/carts", "GET");
    }
    storeAddCart(body) {
      return this.request("/api/store/carts", "POST", void 0, body, "body");
    }
    storeGetCart(params) {
      return this.request("/api/store/cart", "GET", params);
    }
    storeUpdateCart(params, body) {
      return this.request("/api/store/carts", "PUT", params, body, "body");
    }
    storeDeleteCart(params) {
      return this.request("/api/store/carts", "DELETE", params, void 0, "body");
    }
    storeAllUsers() {
      return this.request("/api/store/users", "GET");
    }
    storeAddUser(body) {
      return this.request("/api/store/users", "POST", void 0, body, "body");
    }
    // ==================== NEWS ====================
    AljazeeraEnglish() {
      return this.request("/api/news/aljazeera", "GET");
    }
    AlJazeeraArticle(params) {
      return this.request("/api/aljazeera/article", "GET", params);
    }
    AlJazeeraArabic() {
      return this.request("/api/news/aljazeera/ar", "GET");
    }
    ArabicArticle(params) {
      return this.request("/api/aljazeera/article/ar", "GET", params);
    }
    TRTWorld() {
      return this.request("/api/news/trt", "GET");
    }
    TRTArticle(params) {
      return this.request("/api/trt/article", "GET", params);
    }
    TRTAfrika() {
      return this.request("/api/news/trt/af", "GET");
    }
    AfrikaArticle(params) {
      return this.request("/api/trt/article/af", "GET", params);
    }
    SkyNews() {
      return this.request("/api/news/sky", "GET");
    }
    SkyArticle(params) {
      return this.request("/api/sky/article", "GET", params);
    }
    SkySports() {
      return this.request("/api/news/skysports", "GET");
    }
    SportsArticle(params) {
      return this.request("/api/skysports/article", "GET", params);
    }
    DawnNews() {
      return this.request("/api/news/dawn", "GET");
    }
    DawnArticle(params) {
      return this.request("/api/dawn/article", "GET", params);
    }
    CNNNews() {
      return this.request("/api/news/cnn", "GET");
    }
    CNNArticle(params) {
      return this.request("/api/cnn/article", "GET", params);
    }
    CGTNWorld() {
      return this.request("/api/news/cgtn", "GET");
    }
    CGTNArticle(params) {
      return this.request("/api/cgtn/article", "GET", params);
    }
    GeoUrdu() {
      return this.request("/api/news/geo", "GET");
    }
    GeoArticle(params) {
      return this.request("/api/geo/article", "GET", params);
    }
    GeoEnglish() {
      return this.request("/api/news/geo/en", "GET");
    }
    GeoArticleEn(params) {
      return this.request("/api/geo/article/en", "GET", params);
    }
    GeoSuper() {
      return this.request("/api/news/geosuper", "GET");
    }
    SuperArticle(params) {
      return this.request("/api/geosuper/article", "GET", params);
    }
    ExpressTribune() {
      return this.request("/api/news/tribune", "GET");
    }
    TribuneArticle(params) {
      return this.request("/api/tribune/article", "GET", params);
    }
    NeoNews() {
      return this.request("/api/news/neo", "GET");
    }
    NeoArticle(params) {
      return this.request("/api/neo/article", "GET", params);
    }
    ExpressNews() {
      return this.request("/api/news/express", "GET");
    }
    ExpressArticle(params) {
      return this.request("/api/express/article", "GET", params);
    }
    TheGuardian() {
      return this.request("/api/news/guardian", "GET");
    }
    GuardianArticle(params) {
      return this.request("/api/guardian/article", "GET", params);
    }
    AntaraNews() {
      return this.request("/api/news/antara", "GET");
    }
    AntaraArticle(params) {
      return this.request("/api/antara/article", "GET", params);
    }
    // ==================== STALKER ====================
    stalkPinterest(params) {
      return this.request("/api/stalk/pinterest", "GET", params);
    }
    stalkGithub(params) {
      return this.request("/api/stalk/github", "GET", params);
    }
    stalkInstagram(params) {
      return this.request("/api/stalk/instagram", "GET", params);
    }
    stalkThreads(params) {
      return this.request("/api/stalk/threads", "GET", params);
    }
    stalkTwitter(params) {
      return this.request("/api/stalk/twitter", "GET", params);
    }
    stalkTelegram(params) {
      return this.request("/api/stalk/telegram", "GET", params);
    }
    stalkTikTok(params) {
      return this.request("/api/stalk/tiktok", "GET", params);
    }
    // ==================== SEARCH ====================
    searchGoogle(params) {
      return this.request("/api/search/google", "GET", params);
    }
    searchBing(params) {
      return this.request("/api/search/bing", "GET", params);
    }
    searchBaidu() {
      return this.request("/api/search/baidu", "GET");
    }
    searchWeibo() {
      return this.request("/api/search/weibo", "GET");
    }
    searchImgur(params) {
      return this.request("/api/search/imgur", "GET", params);
    }
    searchTime(params) {
      return this.request("/api/search/time", "GET", params);
    }
    searchFlicker(params) {
      return this.request("/api/search/flicker", "GET", params);
    }
    searchItunes(params) {
      return this.request("/api/search/itunes", "GET", params);
    }
    searchWattpad(params) {
      return this.request("/api/search/wattpad", "GET", params);
    }
    searchStickers(params) {
      return this.request("/api/search/stickers", "GET", params);
    }
    searchYoutube(params) {
      return this.request("/api/search/youtube2", "GET", params);
    }
    searchTracks(params) {
      return this.request("/api/search/youtube2", "GET", params);
    }
    searchGifs(params) {
      return this.request("/api/klipy/gif", "GET", params);
    }
    searchMemes(params) {
      return this.request("/api/klipy/meme", "GET", params);
    }
    // ==================== TOOLS ====================
    toolsCompress(params) {
      return this.request("/api/compress", "GET", params);
    }
    toolsDecompress(params) {
      return this.request("/api/decompress", "GET", params);
    }
    toolsBanklogo(params) {
      return this.request("/api/tools/banklogo", "GET", params);
    }
    toolsDetectLang(params) {
      return this.request("/api/tools/detect", "GET", params);
    }
    toolsDictionary(params) {
      return this.request("/api/tools/dictionary", "GET", params);
    }
    toolsDictionary2(params) {
      return this.request("/api/tools/dict", "GET", params);
    }
    toolsMathematics(params) {
      return this.request("/api/tools/math", "GET", params);
    }
    toolsPreview(params) {
      return this.request("/api/tools/preview", "GET", params);
    }
    toolsScreenshot(params) {
      return this.request("/api/tools/ssweb", "GET", params);
    }
    toolsStyleText(params) {
      return this.request("/api/tools/styletext", "GET", params);
    }
    toolsTranslate(params) {
      return this.request("/api/tools/translate", "GET", params);
    }
    toolsTranslate2(params) {
      return this.request("/api/go/translate", "GET", params);
    }
    toolsPing(params) {
      return this.request("/api/simple/ping", "GET", params);
    }
    toolsCounter(params) {
      return this.request("/api/tools/count", "GET", params);
    }
    toolsHandwriting(params) {
      return this.request("/api/tools/handwrite", "GET", params);
    }
    toolsTextStats(params) {
      return this.request("/api/tools/string", "GET", params);
    }
    toolsWordCount(params) {
      return this.request("/api/word/count", "GET", params);
    }
    toolsUnitConvert(params) {
      return this.request("/api/convert/unit", "GET", params);
    }
    // ==================== MEMES ====================
    memesTwoButton(params) {
      return this.request("/api/meme/buttons", "GET", params);
    }
    memesYelling(params) {
      return this.request("/api/meme/yelling", "GET", params);
    }
    memesSuccess(params) {
      return this.request("/api/meme/success", "GET", params);
    }
    memesPuppet(params) {
      return this.request("/api/meme/puppet", "GET", params);
    }
    memesCouple(params) {
      return this.request("/api/meme/couple", "GET", params);
    }
    memesSquid(params) {
      return this.request("/api/meme/squid", "GET", params);
    }
    memesMask(params) {
      return this.request("/api/meme/mask", "GET", params);
    }
    memesDrowning(params) {
      return this.request("/api/meme/drowning", "GET", params);
    }
    memesDistracted(params) {
      return this.request("/api/meme/boyfriend", "GET", params);
    }
    memesExit(params) {
      return this.request("/api/meme/exit", "GET", params);
    }
    // ==================== PHOTOOXY ====================
    photoPubg(params) {
      return this.request("/api/photo/pubg", "GET", params);
    }
    photoBattle(params) {
      return this.request("/api/photo/battle4", "GET", params);
    }
    photoTikTok(params) {
      return this.request("/api/photo/tiktok", "GET", params);
    }
    photoNeon(params) {
      return this.request("/api/photo/neon", "GET", params);
    }
    photoWarface(params) {
      return this.request("/api/photo/warface", "GET", params);
    }
    photoWarface2(params) {
      return this.request("/api/photo/warface2", "GET", params);
    }
    photoLeague(params) {
      return this.request("/api/photo/league", "GET", params);
    }
    photoLolCover(params) {
      return this.request("/api/photo/lolcover", "GET", params);
    }
    photoLolShine(params) {
      return this.request("/api/photo/lolshine", "GET", params);
    }
    photoMetal(params) {
      return this.request("/api/photo/darkmetal", "GET", params);
    }
    // ==================== EPHOTO360 ====================
    ephotoDeadpool(params) {
      return this.request("/api/ephoto/deadpool", "GET", params);
    }
    ephotoWolf(params) {
      return this.request("/api/ephoto/wolf", "GET", params);
    }
    ephotoShirt(params) {
      return this.request("/api/ephoto/shirt", "GET", params);
    }
    ephotoPencil(params) {
      return this.request("/api/ephoto/sketch", "GET", params);
    }
    ephotoThor(params) {
      return this.request("/api/ephoto/thor", "GET", params);
    }
    ephotoRoyal(params) {
      return this.request("/api/ephoto/royal", "GET", params);
    }
    ephotoComic(params) {
      return this.request("/api/ephoto/comic", "GET", params);
    }
    ephotoWings(params) {
      return this.request("/api/ephoto/angel", "GET", params);
    }
    ephotoFps(params) {
      return this.request("/api/ephoto/game", "GET", params);
    }
    ephotoMetal(params) {
      return this.request("/api/ephoto/mavatar", "GET", params);
    }
    // ==================== INFORMATION ====================
    infoGithubUser(params) {
      return this.request("/api/github/user", "GET", params);
    }
    infoGithubRepo(params) {
      return this.request("/api/github/repo", "GET", params);
    }
    infoIMDb(params) {
      return this.request("/api/info/imdb", "GET", params);
    }
    infoTMDb(params) {
      return this.request("/api/info/tmdb", "GET", params);
    }
    infoUniversity(params) {
      return this.request("/api/info/university", "GET", params);
    }
    infoIP(params) {
      return this.request("/api/info/ip", "GET", params);
    }
    infoTrends(params) {
      return this.request("/api/info/trends", "GET", params);
    }
    infoWeather(params) {
      return this.request("/api/weather/info", "GET", params);
    }
    infoCountry(params) {
      return this.request("/api/info/country", "GET", params);
    }
    infoWikipedia(params) {
      return this.request("/api/info/wiki", "GET", params);
    }
    // ==================== CRYPTO ====================
    CryptoPrice(params) {
      return this.request("/api/info/crypto", "GET", params);
    }
    cryptoList() {
      return this.request("/api/crypto/tags", "GET");
    }
    // ==================== UTILITY METHODS ====================
    setFullResponse(value) {
      this.fullResponse = value;
    }
    getFullResponse() {
      return this.fullResponse;
    }
    setAPIKey(apiKey) {
      this.apiKey = apiKey;
    }
    setTimeout(timeout) {
      this.timeout = timeout;
    }
  };
  var index_default = DiscardAPI;
  return __toCommonJS(index_exports);
})();
