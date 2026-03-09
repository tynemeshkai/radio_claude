#!/usr/bin/env liquidsoap

# ==============================================================================
# 1. SYSTEM & SETTINGS (Liquidsoap 2.4.2 Production)
# ==============================================================================

settings.init.allow_root.set(true)
settings.server.telnet.set(true)
settings.server.telnet.port.set(1234)
settings.server.telnet.bind_addr.set("127.0.0.1")

settings.request.timeout.set(60.)
settings.request.prefetch.set(4)
settings.charset.max_string_length.set(8192)

# ==============================================================================
# НОРМАЛИЗАЦИЯ ГРОМКОСТИ: Autocue
# ==============================================================================
# Autocue анализирует каждый трек по EBU R128 и ставит liq_amplify.
# Целевая громкость: -16 LUFS (стандарт интернет-радио).
# ReplayGain теги сохранены для совместимости, но не применяются во избежание 
# двойной нормализации.

enable_autocue_metadata()

# ==============================================================================
# 2. SECRETS
# ==============================================================================

icecast_pass = environment.get("ICECAST_SOURCE_PASS") ?? ""

# ==============================================================================
# 3. DJ AUTH SYSTEM
# ==============================================================================

current_dj_user   = ref("")
dj_kick_cancelled = ref(false)
current_dj_name   = ref("")

def dj_auth_func(args) =
  user = args.user
  pass = args.password
  addr = args.address

  safe_user = string.replace(pattern="[^a-zA-Z0-9_]", fun (_) -> "", user)
  safe_addr = string.replace(pattern="[^a-zA-Z0-9.:]", fun (_) -> "", addr)

  cmd = "printf '%s\\n%s\\n%s\\n' '#{safe_user}' '#{pass}' '#{safe_addr}' | python3 /usr/local/bin/dj_auth.py"
  result = string.trim(process.read(cmd))

  if result == "true" then
    current_dj_user := user
    print("[DJ Auth] ✅ #{safe_user} from #{safe_addr}")
    true
  else
    print("[DJ Auth] ❌ #{safe_user} from #{safe_addr}: '#{result}'")
    false
  end
end

def dj_on_connect(_headers) =
  dj_user = current_dj_user()
  dj_kick_cancelled := false

  cmd_max_mins = "python3 -c \"import json; print(json.load(open('/tmp/dj_current_session.json')).get('max_minutes',0))\" 2>/dev/null || echo '0'"
  max_str      = string.trim(process.read(cmd_max_mins))
  max_minutes  = int_of_string(default=0, max_str)

  cmd_dj_name  = "python3 -c \"import json; print(json.load(open('/tmp/dj_current_session.json')).get('name',''))\" 2>/dev/null || echo ''"
  dj_name      = string.trim(process.read(cmd_dj_name))

  current_dj_name := dj_name
  print("[DJ] 🎧 #{dj_name} (#{dj_user}) connected, limit: #{max_minutes} min")

  # Сразу пишем в nowplaying.json чтобы фронт знал что идёт лайв
  live_track = if dj_name != "" then "LIVE: #{dj_name} - Live Session" else "LIVE: LOCAL FARTS - Live Session" end
  ignore(process.run("/usr/local/bin/write_history.sh " ^ "'" ^ string.replace(pattern="'", fun(_) -> "'\\''", live_track) ^ "'"))

  if max_minutes > 0 then
    max_seconds = float(max_minutes * 60)

    thread.run(delay=max_seconds, fun () -> begin
      if not dj_kick_cancelled() then
        print("[DJ] ⏰ Auto-kick #{dj_user} after #{max_minutes} min")
        ignore(process.read("/usr/local/bin/dj_session.py disconnect 2>/dev/null"))
        log_cmd = "echo \"[$(date '+%Y-%m-%d %H:%M:%S')] AUTO-KICK #{dj_user} (exceeded #{max_minutes} min)\" >> /var/log/localfarts/dj.log"
        ignore(process.read(log_cmd))
        ignore(process.read("echo 'live_harbor.stop' | nc -w 2 127.0.0.1 1234 2>/dev/null"))
      end
    end)
  end
end

def dj_on_disconnect() =
  dj_user = current_dj_user()
  print("[DJ] 👋 #{dj_user} disconnected")

  dj_kick_cancelled := true
  current_dj_user   := ""
  current_dj_name   := ""

  ignore(process.read("/usr/local/bin/dj_session.py disconnect 2>/dev/null"))
end

# ==============================================================================
# 4. SOURCES
# ==============================================================================

# --- LIVE DJ ---
live = input.harbor(
  "live",
  id="live_harbor",
  port=8005,
  auth=dj_auth_func,
  on_connect=dj_on_connect,
  on_disconnect=dj_on_disconnect,
  buffer=12.0,
  max=30.0
)

# --- ИНТЕРСЕПТОР МЕТАДАННЫХ ДЛЯ ПРЯМОГО ЭФИРА ---
def override_live_meta(m) =
  orig_artist = m["artist"] ?? ""
  orig_title  = m["title"] ?? ""
  
  new_title = 
    if orig_artist != "" and orig_title != "" then
      "#{orig_artist} - #{orig_title}"
    elsif orig_title != "" then
      orig_title
    elsif orig_artist != "" then
      orig_artist
    else
      "Live Session"
    end

  dj = current_dj_name()
  new_artist = if dj != "" then "LIVE: #{dj}" else "LIVE: LOCAL FARTS" end

  [("artist", new_artist), ("title", new_title), ("source", "live")]
end

live = map_metadata(update=true, override_live_meta, live)

# --- SMART TRACK PICKER ---
def get_smart_track() =
  cmd_picker = "/bin/bash -lc '/usr/local/bin/smart-picker.py 2>/dev/null || /usr/bin/shuf -n1 /srv/radio/music.m3u'"
  result     = string.trim(process.read(cmd_picker))
  
  if result != "" then
    request.create(result)
  else
    fallback_cmd = "/usr/bin/shuf -n1 /srv/radio/music.m3u"
    request.create(string.trim(process.read(fallback_cmd)))
  end
end

background_music_smart = request.dynamic(
  id="smart_dynamic",
  timeout=45.0,
  retry_delay=2.0,
  get_smart_track
)

# --- FALLBACKS & JINGLES ---
background_music_fallback = playlist(
  id="music_fallback", mode="randomize", reload_mode="watch", "/srv/radio/music.m3u"
)

jingles = playlist(
  id="jingles_playlist", 
  mode="randomize", 
  reload_mode="watch", 
  prefix="annotate:is_jingle=\"true\",liq_cross_duration=\"0.1\":",
  "/srv/radio/jingles.m3u"
)

# --- PRE-PROCESSING ---
music_source = fallback(track_sensitive=false, [background_music_smart, background_music_fallback])

# Микс: 6 песен к 1 джинглу
radio_source = random(weights=[6, 1], [music_source, jingles])

# Защита от тишины
radio_source = blank.skip(
  max_blank=3.0, threshold=-60.0, track_sensitive=false, radio_source
)

requests = request.queue(id="requests")
autodj   = fallback(id="autodj", track_sensitive=true, [requests, radio_source])

# ==============================================================================
# 4.5 HISTORY LOGGING
# ==============================================================================

def bash_quote(s) =
  escaped = string.replace(pattern="'", fun (_) -> "'\\''", s)
  "'#{escaped}'"
end

last_written_track = ref("")

def get_track_name(m) =
  artist     = m["artist"] ?? ""
  title      = m["title"] ?? ""
  song       = m["song"] ?? ""
  source_tag = m["source"] ?? ""

  if source_tag == "live" then
    # Включаем artist ("LIVE: DJ Name") чтобы он дошёл до nowplaying.json
    if artist != "" and title != "" then
      "#{artist} - #{title}"
    elsif title != "" then
      title
    elsif artist != "" then
      artist
    else
      "Live Session"
    end
  elsif artist != "" and title != "" then
    "#{artist} - #{title}"
  elsif title != "" then
    title
  else
    song
  end
end

def update_history(m) =
  is_jingle = m["is_jingle"] ?? "false"

  if is_jingle == "true" then
    print("MetaData: Jingle playing (History skipped)")
  else
    track_name   = get_track_name(m)
    current_last = last_written_track()
    
    if track_name != "" and track_name != "Unknown Track" and track_name != current_last then
      last_written_track := track_name

      thread.run(fun () -> begin
        safe_name = bash_quote(track_name)
        cmd       = "/usr/local/bin/write_history.sh #{safe_name}"
        ignore(process.run(cmd))
      end)
    end
  end
end

autodj.on_track(synchronous=false, update_history)

# ==============================================================================
# 5. ENERGY-BASED SMART CROSSFADE
# ==============================================================================

def energy_crossfade(old, new) =
  old_amplify = float_of_string(default=0.0, old.metadata["liq_amplify"] ?? "0")
  new_amplify = float_of_string(default=0.0, new.metadata["liq_amplify"] ?? "0")

  old_is_jingle = (old.metadata["is_jingle"] ?? "false") == "true"
  new_is_jingle = (new.metadata["is_jingle"] ?? "false") == "true"

  if old_is_jingle or new_is_jingle then
    log("[CrossFade] Jingle detected → quick cut")
    sequence([
      fade.out(duration=0.3, old.source),
      fade.in(duration=0.3, new.source)
    ])
  else
    old_energy =
      if old_amplify > 6.0 then "calm"
      elsif old_amplify < -2.0 then "hot"
      else "mid" end

    new_energy =
      if new_amplify > 6.0 then "calm"
      elsif new_amplify < -2.0 then "hot"
      else "mid" end

    log("[CrossFade] old=#{old_energy} (#{old_amplify} dB) → new=#{new_energy} (#{new_amplify} dB)")

    if old_energy == "calm" and new_energy == "calm" then
      add(normalize=false, [
        fade.out(type="sin", duration=5.0, old.source),
        fade.in(type="sin", duration=4.0, new.source)
      ])
    elsif old_energy == "calm" and new_energy == "hot" then
      add(normalize=false, [
        fade.out(type="exp", duration=1.5, old.source),
        fade.in(type="exp", duration=0.5, new.source)
      ])
    elsif old_energy == "hot" and new_energy == "calm" then
      add(normalize=false, [
        fade.out(type="sin", duration=2.5, old.source),
        fade.in(type="sin", duration=3.5, new.source)
      ])
    elsif old_energy == "hot" and new_energy == "hot" then
      add(normalize=false, [
        fade.out(type="exp", duration=1.5, old.source),
        fade.in(type="exp", duration=1.0, new.source)
      ])
    else
      add(normalize=false, [
        fade.out(type="sin", duration=3.0, old.source),
        fade.in(type="sin", duration=2.5, new.source)
      ])
    end
  end
end

autodj = cross(duration=4.0, energy_crossfade, autodj)

def transition_to_live(old, new) =
  add(normalize=false, [fade.initial(duration=1.0, new), fade.final(duration=3.0, old)])
end

def transition_to_autodj(old, new) =
  add(normalize=false, [fade.initial(duration=3.0, new), fade.final(duration=2.0, old)])
end

radio = fallback(
  track_sensitive=false,
  transitions=[transition_to_live, transition_to_autodj],
  [live, autodj]
)

# ==============================================================================
# 6. METADATA NORMALIZATION (ОЧИСТКА МУСОРА)
# ==============================================================================

def clean_metadata(m) =
  def clean_str(s) =
    # Разбили адский regex на переменные для читаемости
    ext_regex   = "\\.\\(mp3\\|flac\\|wav\\|ogg\\|m4a\\|MP3\\|FLAC\\|WAV\\|OGG\\|M4A\\)$"
    tags_regex  = "\\(Remaster\\|remaster\\|REMASTER\\|Original Mix\\|original mix\\|ORIGINAL MIX\\|Radio Edit\\|radio edit\\|RADIO EDIT\\|Official\\|official\\|OFFICIAL\\|Lyric\\|lyric\\|LYRIC\\|Video\\|video\\|VIDEO\\|Audio\\|audio\\|AUDIO\\)"
    
    paren_regex = " *([^)]*#{tags_regex}[^)]*)"
    brack_regex = " *\\[[^]]*#{tags_regex}[^]]*\\]"
    dash_regex  = " *- \\(Remaster\\|remaster\\|REMASTER\\|Radio Edit\\|radio edit\\|RADIO EDIT\\|Official Video\\|official video\\|OFFICIAL VIDEO\\).*$"

    s1 = string.replace(pattern=ext_regex, fun (_) -> "", s)
    s2 = string.replace(pattern=paren_regex, fun (_) -> "", s1)
    s3 = string.replace(pattern=brack_regex, fun (_) -> "", s2)
    s4 = string.replace(pattern=dash_regex, fun (_) -> "", s3)
    
    string.trim(s4)
  end

  title  = m["title"] ?? ""
  artist = m["artist"] ?? ""
  song   = m["song"] ?? ""

  [("title", clean_str(title)), ("artist", clean_str(artist)), ("song", clean_str(song))]
end

radio = map_metadata(update=true, clean_metadata, radio)

# ==============================================================================
# 7. LIVE DJ METADATA FALLBACK & LIMITER
# ==============================================================================

radio.on_metadata(synchronous=false, fun (m) -> begin
  source_tag = m["source"] ?? ""
  if source_tag == "live" or source_tag == "live_harbor" then
    update_history(m)
  end
end)

radio = mksafe(radio)

# Мягкий лимитер для защиты FLAC-контейнера от клиппинга
radio = limit(attack=2.0, release=50.0, threshold=-0.2, radio)

# ==============================================================================
# 8. OUTPUT (RAW LOSSLESS FLAC → ICECAST)
# ==============================================================================

# ==============================================================================
# 8. OUTPUT (RAW LOSSLESS FLAC → ICECAST → FFmpeg HLS)
# ==============================================================================
output.icecast(
  id="icecast_out",
  %ffmpeg(
    format="ogg",   # <--- ДОЛЖНО БЫТЬ OGG
    %audio(
        codec="flac",
        samplerate=44100,
        channels=2,
        compression_level=5
    )
  ),
  host="127.0.0.1", port=8000, password=icecast_pass, mount="/stream_lossless.ogg", # <--- ДОЛЖНО БЫТЬ .ogg
  name="LOCAL FARTS", description="LOSSLESS FEED", url="https://localfarts.lol",
  send_icy_metadata=false,
  radio
)