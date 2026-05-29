// ==========================================================================
// FocusAura App - Core Timer, Audio, Calendar & Celebration Logic
// ==========================================================================

import { syncDataWithGoogle, loadGoogleClientId, saveGoogleClientId, isUserLoggedIn } from './auth.js';

// Application State
const state = {
  // Timer settings
  totalDuration: 4 * 60 * 60 * 1000, // 4 hours in ms
  timeRemaining: 4 * 60 * 60 * 1000,
  timerState: 'IDLE', // IDLE, RUNNING, PAUSED, COMPLETED
  endTime: null,
  animationFrameId: null,
  tickIntervalId: null,

  // Audio settings
  soundEnabled: false,
  volume: 0.3, // 0.0 to 1.0
  audioCtx: null,

  // User History Data
  history: {}, // Key: YYYY-MM-DD, Value: number of blocks completed
  
  // Calendar Navigation
  currentCalendarDate: new Date(),
  
  // Confetti particles
  confettiActive: false,
  confettiParticles: []
};

// SVG Progress Ring details (radius = 145, circumference ~ 911)
const CIRCUMFERENCE = 2 * Math.PI * 145;

// Elements caching
const timeDisplay = document.getElementById('time-display');
const timerStateLabel = document.getElementById('timer-state-label');
const startBtn = document.getElementById('timer-start-btn');
const pauseBtn = document.getElementById('timer-pause-btn');
const resetBtn = document.getElementById('timer-reset-btn');
const audioToggleBtn = document.getElementById('audio-toggle-btn');
const progressBar = document.getElementById('progress-ring-bar');
const rotaryDial = document.getElementById('rotary-dial');
const dialPointerLine = document.getElementById('dial-pointer-line');
const ambientGlow = document.getElementById('ambient-glow');

// Calendar Elements
const calendarMonthYear = document.getElementById('calendar-month-year');
const calendarDaysGrid = document.getElementById('calendar-days-grid');
const prevMonthBtn = document.getElementById('prev-month-btn');
const nextMonthBtn = document.getElementById('next-month-btn');
const manualLogTodayBtn = document.getElementById('manual-log-today-btn');

// Stats Elements
const statTotalBlocks = document.getElementById('stat-total-blocks');
const statCurrentStreak = document.getElementById('stat-current-streak');
const statWeeklyRate = document.getElementById('stat-weekly-rate');
const statPerfectDays = document.getElementById('stat-perfect-days');

// Modals Elements
const settingsModal = document.getElementById('settings-modal');
const settingsToggleBtn = document.getElementById('settings-toggle-btn');
const settingsCloseBtn = document.getElementById('settings-close-btn');
const tickVolumeSlider = document.getElementById('tick-volume-slider');
const volumeValDisplay = document.getElementById('volume-val-display');

const dayModal = document.getElementById('day-modal');
const dayModalCloseBtn = document.getElementById('day-modal-close-btn');
const dayModalDate = document.getElementById('day-modal-date');
const dayModalCount = document.getElementById('day-modal-count');
const dayModalMinusBtn = document.getElementById('day-modal-minus-btn');
const dayModalPlusBtn = document.getElementById('day-modal-plus-btn');
const dayModalSaveBtn = document.getElementById('day-modal-save-btn');
const dayModalRewardDisplay = document.getElementById('day-modal-reward-display');

// Debug Elements
const debugFastForwardBtn = document.getElementById('debug-fast-forward-btn');
const debugAddPastDataBtn = document.getElementById('debug-add-past-data-btn');
const debugClearDataBtn = document.getElementById('debug-clear-data-btn');

// Target completions
const DAILY_TARGET = 3;

// Active selected day for manual logging modal
let activeSelectedDayStr = null;

// ==========================================================================
// Initialization
// ==========================================================================
document.addEventListener('DOMContentLoaded', () => {
  loadData();
  initCalendar();
  generateDialTicks();
  initAudioSettingsUI();
  setupEventListeners();
  checkActiveTimerOnLoad();
  
  // SVG gradient definition
  createSVGGradient();
  
  // Render loop for confetti
  requestAnimationFrame(confettiRenderLoop);
});

// ==========================================================================
// Data & LocalStorage Management
// ==========================================================================
function loadData() {
  const localData = localStorage.getItem('focus_aura_data');
  if (localData) {
    try {
      const parsed = JSON.parse(localData);
      state.history = parsed.history || {};
      state.volume = parsed.volume !== undefined ? parsed.volume : 0.3;
      state.soundEnabled = parsed.soundEnabled || false;
    } catch (e) {
      console.error('Error loading data from localStorage', e);
    }
  }
  
  updateDashboard();
}

function saveData() {
  const dataToSave = {
    history: state.history,
    volume: state.volume,
    soundEnabled: state.soundEnabled
  };
  localStorage.setItem('focus_aura_data', JSON.stringify(dataToSave));
  updateDashboard();
  
  // Sync if signed in
  if (isUserLoggedIn()) {
    triggerCloudSync();
  }
}

// Exportable sync receiver to let auth.js update state
export function handleCloudDataSynced(cloudHistory) {
  // Merge cloud history with local history (take max block count per day)
  const mergedHistory = { ...state.history };
  let hasChanges = false;
  
  for (const [dateStr, cloudCount] of Object.entries(cloudHistory)) {
    const localCount = mergedHistory[dateStr] || 0;
    if (cloudCount > localCount) {
      mergedHistory[dateStr] = cloudCount;
      hasChanges = true;
    }
  }
  
  // Write back to cloud any local entries that weren't in cloud
  for (const [dateStr, localCount] of Object.entries(state.history)) {
    if (cloudHistory[dateStr] === undefined || cloudHistory[dateStr] < localCount) {
      cloudHistory[dateStr] = localCount;
      hasChanges = true;
    }
  }
  
  state.history = mergedHistory;
  
  const dataToSave = {
    history: state.history,
    volume: state.volume,
    soundEnabled: state.soundEnabled
  };
  localStorage.setItem('focus_aura_data', JSON.stringify(dataToSave));
  updateDashboard();
  
  return hasChanges ? cloudHistory : null;
}

// Trigger Google Sync
async function triggerCloudSync() {
  const syncIndicator = document.getElementById('sync-status');
  if (!syncIndicator) return;
  
  syncIndicator.className = 'sync-indicator syncing';
  syncIndicator.querySelector('.sync-text').innerText = 'Syncing...';
  
  try {
    const merged = await syncDataWithGoogle(state.history);
    if (merged) {
      state.history = merged;
      localStorage.setItem('focus_aura_data', JSON.stringify({
        history: state.history,
        volume: state.volume,
        soundEnabled: state.soundEnabled
      }));
      updateDashboard();
    }
    syncIndicator.className = 'sync-indicator synced';
    syncIndicator.querySelector('.sync-text').innerText = 'Synced';
    syncIndicator.title = 'Saved to Google Drive appdata';
  } catch (err) {
    console.error('Cloud sync failed:', err);
    syncIndicator.className = 'sync-indicator offline';
    syncIndicator.querySelector('.sync-text').innerText = 'Local Only';
    syncIndicator.title = 'Cloud sync failed. Working offline.';
  }
}

// Check if a timer was running when page was closed
function checkActiveTimerOnLoad() {
  const activeTimerData = localStorage.getItem('focus_aura_active_timer');
  if (!activeTimerData) return;
  
  try {
    const data = JSON.parse(activeTimerData);
    if (data.timerState === 'RUNNING') {
      const now = Date.now();
      const elapsedSinceClose = now - data.lastSavedTime;
      const targetEndTime = data.endTime;
      
      if (now >= targetEndTime) {
        // Completed while away!
        state.timerState = 'COMPLETED';
        state.timeRemaining = 0;
        localStorage.removeItem('focus_aura_active_timer');
        
        // Log block
        logBlockToday();
        updateTimerUI();
        triggerTriumphCelebration();
      } else {
        // Resume running
        state.timerState = 'RUNNING';
        state.endTime = targetEndTime;
        state.timeRemaining = targetEndTime - now;
        startTimerEngine();
      }
    } else if (data.timerState === 'PAUSED') {
      state.timerState = 'PAUSED';
      state.timeRemaining = data.timeRemaining;
      updateTimerUI();
    }
  } catch (e) {
    console.error('Error recovering active timer state', e);
  }
}

function saveActiveTimerState() {
  if (state.timerState === 'RUNNING' || state.timerState === 'PAUSED') {
    const activeData = {
      timerState: state.timerState,
      timeRemaining: state.timeRemaining,
      endTime: state.endTime,
      lastSavedTime: Date.now()
    };
    localStorage.setItem('focus_aura_active_timer', JSON.stringify(activeData));
  } else {
    localStorage.removeItem('focus_aura_active_timer');
  }
}

// ==========================================================================
// Timer Core Engine
// ==========================================================================
function startTimer() {
  if (state.timerState === 'RUNNING') return;
  
  initAudioContext();
  
  if (state.timerState === 'IDLE' || state.timerState === 'COMPLETED') {
    state.timeRemaining = state.totalDuration;
  }
  
  state.timerState = 'RUNNING';
  state.endTime = Date.now() + state.timeRemaining;
  
  startTimerEngine();
  saveActiveTimerState();
}

function startTimerEngine() {
  // Clear previous timers
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  if (state.tickIntervalId) clearInterval(state.tickIntervalId);
  
  // Timer tick animation loop
  const updateTick = () => {
    if (state.timerState !== 'RUNNING') return;
    
    const now = Date.now();
    state.timeRemaining = Math.max(0, state.endTime - now);
    
    updateTimerUI();
    
    if (state.timeRemaining <= 0) {
      completeTimer();
    } else {
      state.animationFrameId = requestAnimationFrame(updateTick);
    }
  };
  
  state.animationFrameId = requestAnimationFrame(updateTick);
  
  // Rhythmic tick audio interval
  state.tickIntervalId = setInterval(() => {
    if (state.timerState === 'RUNNING' && state.soundEnabled) {
      playTickSound();
    }
  }, 1000);
  
  // Update ambient glow classes
  ambientGlow.classList.add('active');
  updateTimerUI();
}

function pauseTimer() {
  if (state.timerState !== 'RUNNING') return;
  
  state.timerState = 'PAUSED';
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  if (state.tickIntervalId) clearInterval(state.tickIntervalId);
  
  ambientGlow.classList.remove('active');
  updateTimerUI();
  saveActiveTimerState();
}

function resetTimer() {
  state.timerState = 'IDLE';
  state.timeRemaining = state.totalDuration;
  state.endTime = null;
  
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  if (state.tickIntervalId) clearInterval(state.tickIntervalId);
  
  ambientGlow.classList.remove('active');
  document.body.classList.remove('urgent-vignette');
  
  updateTimerUI();
  saveActiveTimerState();
}

function completeTimer() {
  state.timerState = 'COMPLETED';
  state.timeRemaining = 0;
  state.endTime = null;
  
  if (state.animationFrameId) cancelAnimationFrame(state.animationFrameId);
  if (state.tickIntervalId) clearInterval(state.tickIntervalId);
  
  ambientGlow.classList.remove('active');
  document.body.classList.remove('urgent-vignette');
  
  saveActiveTimerState();
  
  // Log the block
  logBlockToday();
  updateTimerUI();
  triggerTriumphCelebration();
}

// Log block to today's entry
function logBlockToday() {
  const todayStr = getLocalDateString(new Date());
  state.history[todayStr] = (state.history[todayStr] || 0) + 1;
  saveData();
}

// Helper to format date consistently in YYYY-MM-DD local time
function getLocalDateString(date) {
  const year = date.getFullYear();
  const month = String(date.getMonth() + 1).padStart(2, '0');
  const day = String(date.getDate()).padStart(2, '0');
  return `${year}-${month}-${day}`;
}

// ==========================================================================
// Timer Visual UI Styling Updates
// ==========================================================================
function updateTimerUI() {
  const hours = Math.floor(state.timeRemaining / (1000 * 60 * 60));
  const minutes = Math.floor((state.timeRemaining % (1000 * 60 * 60)) / (1000 * 60));
  const seconds = Math.floor((state.timeRemaining % (1000 * 60)) / 1000);
  
  // Digital Text
  timeDisplay.innerText = `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
  
  // State Labels and Buttons
  if (state.timerState === 'RUNNING') {
    timerStateLabel.innerText = 'FOCUSING';
    timerStateLabel.style.color = 'var(--aura-color)';
    startBtn.classList.add('hidden');
    pauseBtn.classList.remove('hidden');
    resetBtn.removeAttribute('disabled');
  } else if (state.timerState === 'PAUSED') {
    timerStateLabel.innerText = 'PAUSED';
    timerStateLabel.style.color = 'var(--color-warning)';
    startBtn.classList.remove('hidden');
    startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Resume';
    pauseBtn.classList.add('hidden');
    resetBtn.removeAttribute('disabled');
  } else if (state.timerState === 'COMPLETED') {
    timerStateLabel.innerText = 'ACHIEVED';
    timerStateLabel.style.color = 'var(--color-success)';
    startBtn.classList.remove('hidden');
    startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start New';
    pauseBtn.classList.add('hidden');
    resetBtn.setAttribute('disabled', 'true');
  } else { // IDLE
    timerStateLabel.innerText = 'READY';
    timerStateLabel.style.color = 'var(--text-muted)';
    startBtn.classList.remove('hidden');
    startBtn.innerHTML = '<i class="fa-solid fa-play"></i> Start Block';
    pauseBtn.classList.add('hidden');
    resetBtn.setAttribute('disabled', 'true');
  }
  
  // Urgency Style Rules
  const progressRatio = state.timeRemaining / state.totalDuration;
  let currentColor = 'var(--color-safe-primary)';
  let glowDuration = '4s';
  
  // 1. Calculate color states based on time remaining
  if (state.timeRemaining <= 15 * 60 * 1000) { // < 15 mins (Urgent!)
    currentColor = 'var(--color-danger)';
    glowDuration = '0.6s';
    document.body.classList.add('urgent-vignette');
  } else if (state.timeRemaining <= 2 * 60 * 60 * 1000) { // < 2 hours (Warning)
    currentColor = 'var(--color-warning)';
    glowDuration = '2s';
    document.body.classList.remove('urgent-vignette');
  } else { // Safe (> 2 hours)
    currentColor = 'var(--color-safe-primary)';
    glowDuration = '4s';
    document.body.classList.remove('urgent-vignette');
  }
  
  // Apply CSS Variables dynamically
  document.documentElement.style.setProperty('--aura-color', currentColor);
  document.documentElement.style.setProperty('--aura-pulse-duration', glowDuration);
  
  // 2. Rotate Dial (Clockwise wind down from 360 to 0)
  const angle = progressRatio * 360;
  dialPointerLine.style.transform = `rotate(${angle}deg)`;
  
  // 3. SVG Progress Stroke Offset
  const offset = CIRCUMFERENCE - (progressRatio * CIRCUMFERENCE);
  progressBar.style.strokeDashoffset = offset;
}

// Generates tick marks on the brushed metal dial
function generateDialTicks() {
  const ticksContainer = rotaryDial.querySelector('.dial-ticks');
  ticksContainer.innerHTML = '';
  
  // Generate 60 ticks around the dial (every 6 degrees)
  for (let i = 0; i < 60; i++) {
    const angle = i * 6;
    const tick = document.createElement('div');
    tick.className = 'tick';
    
    // Major ticks every 5 minutes (30 degrees)
    if (i % 5 === 0) {
      tick.classList.add('major');
    }
    
    tick.style.transform = `rotate(${angle}deg)`;
    ticksContainer.appendChild(tick);
  }
}

// Set up linear gradient within SVG definitions
function createSVGGradient() {
  const svg = document.querySelector('.progress-ring-svg');
  
  // Inject definitions tags
  let defs = svg.querySelector('defs');
  if (!defs) {
    defs = document.createElementNS('http://www.w3.org/2000/svg', 'defs');
    svg.insertBefore(defs, svg.firstChild);
  }
  
  defs.innerHTML = `
    <linearGradient id="aura-gradient" x1="0%" y1="0%" x2="100%" y2="100%">
      <stop offset="0%" stop-color="var(--aura-color)" />
      <stop offset="100%" stop-color="var(--color-safe-secondary)" />
    </linearGradient>
  `;
}

// ==========================================================================
// Web Audio API Synthesizer (Heartbeat & Bells)
// ==========================================================================
function initAudioContext() {
  if (!state.audioCtx) {
    state.audioCtx = new (window.AudioContext || window.webkitAudioContext)();
  }
  // Resume if suspended (browser security policies)
  if (state.audioCtx.state === 'suspended') {
    state.audioCtx.resume();
  }
}

function initAudioSettingsUI() {
  // Volume Slider Sync
  tickVolumeSlider.value = state.volume * 100;
  volumeValDisplay.innerText = `${Math.round(state.volume * 100)}%`;
  
  // Audio toggle icon state
  updateAudioIcon();
}

function updateAudioIcon() {
  const icon = audioToggleBtn.querySelector('i');
  if (state.soundEnabled) {
    audioToggleBtn.className = 'btn btn-primary btn-icon-only';
    icon.className = 'fa-solid fa-volume-high';
  } else {
    audioToggleBtn.className = 'btn btn-secondary btn-icon-only';
    icon.className = 'fa-solid fa-volume-xmark';
  }
}

// Generates dynamic thumping tick
function playTickSound() {
  if (!state.audioCtx) return;
  
  try {
    const now = state.audioCtx.currentTime;
    
    // Heartbeat structure (double thump)
    // First beat
    playSingleThump(now);
    
    // Second beat (0.25s later)
    playSingleThump(now + 0.22);
  } catch (err) {
    console.warn('Audio tick playback missed due to suspended context:', err);
  }
}

function playSingleThump(time) {
  const osc = state.audioCtx.createOscillator();
  const gain = state.audioCtx.createGain();
  
  osc.connect(gain);
  gain.connect(state.audioCtx.destination);
  
  // Heartbeat sound shape: low-frequency kick sweep (100Hz -> 20Hz)
  osc.type = 'sine';
  osc.frequency.setValueAtTime(85, time);
  // Fast frequency sweep for thump feel
  osc.frequency.exponentialRampToValueAtTime(15, time + 0.12);
  
  // Gain envelope: fast decay
  gain.gain.setValueAtTime(state.volume * 0.8, time);
  gain.gain.exponentialRampToValueAtTime(0.01, time + 0.12);
  
  osc.start(time);
  osc.stop(time + 0.13);
}

// Generates a shimmering pentatonic success chime
function playCompletionChime() {
  initAudioContext();
  if (!state.audioCtx || !state.soundEnabled) return;
  
  const now = state.audioCtx.currentTime;
  
  // Beautiful major chord progression arpeggio (C5 - E5 - G5 - C6)
  const notes = [523.25, 659.25, 783.99, 1046.50]; // frequencies
  
  notes.forEach((freq, idx) => {
    const playTime = now + (idx * 0.15);
    const osc = state.audioCtx.createOscillator();
    const gain = state.audioCtx.createGain();
    
    // Sine wave mixed with triangle for bell-like tone
    osc.type = 'triangle';
    osc.frequency.setValueAtTime(freq, playTime);
    
    // Low pass filter for warmness
    const filter = state.audioCtx.createBiquadFilter();
    filter.type = 'lowpass';
    filter.frequency.setValueAtTime(1500, playTime);
    
    osc.connect(filter);
    filter.connect(gain);
    gain.connect(state.audioCtx.destination);
    
    // Volume envelope (bell strike: instant attack, long ring decay)
    gain.gain.setValueAtTime(0, playTime);
    gain.gain.linearRampToValueAtTime(state.volume * 0.7, playTime + 0.02);
    gain.gain.exponentialRampToValueAtTime(0.001, playTime + 1.2);
    
    osc.start(playTime);
    osc.stop(playTime + 1.3);
  });
}

// ==========================================================================
// Dashboard Calendar Rendering
// ==========================================================================
function initCalendar() {
  renderCalendar();
}

function renderCalendar() {
  calendarDaysGrid.innerHTML = '';
  
  const date = state.currentCalendarDate;
  const year = date.getFullYear();
  const month = date.getMonth();
  
  // Set month title
  const monthNames = [
    'January', 'February', 'March', 'April', 'May', 'June',
    'July', 'August', 'September', 'October', 'November', 'December'
  ];
  calendarMonthYear.innerText = `${monthNames[month]} ${year}`;
  
  // First day of the month index (0: Sunday, 1: Monday etc. -> converting to Mon-Sun layout)
  // Standard getDay(): 0=Sun, 1=Mon, ..., 6=Sat
  const firstDayIndex = new Date(year, month, 1).getDay();
  // Adjust to Mon-Sun (Mon: 0, Tue: 1, ..., Sun: 6)
  let startOffset = firstDayIndex === 0 ? 6 : firstDayIndex - 1;
  
  // Total days in month
  const totalDays = new Date(year, month + 1, 0).getDate();
  
  // Total days in previous month
  const prevMonthTotalDays = new Date(year, month, 0).getDate();
  
  // Render previous month's trailing days (Empty/disabled cells)
  for (let i = startOffset; i > 0; i--) {
    const cell = document.createElement('div');
    cell.className = 'day-cell day-empty';
    const prevDay = prevMonthTotalDays - i + 1;
    cell.innerHTML = `<span class="day-num">${prevDay}</span>`;
    calendarDaysGrid.appendChild(cell);
  }
  
  const today = new Date();
  const todayStr = getLocalDateString(today);
  
  // Render actual month days
  for (let d = 1; d <= totalDays; d++) {
    const dayDate = new Date(year, month, d);
    const dayStr = getLocalDateString(dayDate);
    const completions = state.history[dayStr] || 0;
    
    const cell = document.createElement('div');
    cell.className = 'day-cell';
    
    // Highlight today
    if (dayStr === todayStr) {
      cell.classList.add('day-today');
    }
    
    // Apply styling state based on block completions count
    let indicatorHTML = '';
    
    if (completions === 0) {
      cell.classList.add('day-zero');
      indicatorHTML = '<span class="day-indicator"></span>';
    } else if (completions < DAILY_TARGET) {
      cell.className += ` day-partial-${completions}`;
      indicatorHTML = '<span class="day-indicator"></span>';
    } else if (completions === DAILY_TARGET) {
      cell.classList.add('day-target-met');
      indicatorHTML = '<span class="day-indicator"><i class="fa-solid fa-check"></i></span>';
    } else { // Exceeded (>= 4 blocks)
      cell.classList.add('day-exceeded');
      indicatorHTML = '<span class="day-indicator"><i class="fa-solid fa-star animate-pulse"></i></span>';
    }
    
    cell.innerHTML = `
      <span class="day-num">${d}</span>
      ${indicatorHTML}
    `;
    
    // Open editor modal on click
    cell.addEventListener('click', () => openDayEditorModal(dayStr));
    
    calendarDaysGrid.appendChild(cell);
  }
}

// Open modal to manually adjust completion blocks for a specific day
function openDayEditorModal(dayStr) {
  activeSelectedDayStr = dayStr;
  
  // Format readable title
  const dateObj = new Date(dayStr + 'T00:00:00');
  const options = { weekday: 'long', year: 'numeric', month: 'long', day: 'numeric' };
  dayModalDate.innerText = dateObj.toLocaleDateString('en-US', options);
  
  // Set values
  const count = state.history[dayStr] || 0;
  dayModalCount.innerText = count;
  
  updateDayModalRewardDisplay(count);
  
  dayModal.classList.remove('hidden');
}

function updateDayModalRewardDisplay(count) {
  dayModalRewardDisplay.innerHTML = '';
  
  if (count >= 4) {
    dayModalRewardDisplay.innerHTML = `
      <div class="reward-badge-large gold animate-scale-up">
        <i class="fa-solid fa-star"></i> Target Exceeded (Gold Star!)
      </div>
    `;
  } else if (count === 3) {
    dayModalRewardDisplay.innerHTML = `
      <div class="reward-badge-large success animate-scale-up">
        <i class="fa-solid fa-circle-check"></i> Target Met (Green Check!)
      </div>
    `;
  }
}

function closeDayEditorModal() {
  dayModal.classList.add('hidden');
  activeSelectedDayStr = null;
}

// Adjust calendar month view
function navigateMonth(direction) {
  state.currentCalendarDate.setMonth(state.currentCalendarDate.getMonth() + direction);
  renderCalendar();
}

// ==========================================================================
// Statistics Dashboard Calculations
// ==========================================================================
function updateDashboard() {
  // 1. Total blocks
  let totalBlocks = 0;
  for (const count of Object.values(state.history)) {
    totalBlocks += count;
  }
  statTotalBlocks.innerText = totalBlocks;
  
  // 2. Perfect days count (>= 3 blocks completed)
  let perfectDays = 0;
  for (const count of Object.values(state.history)) {
    if (count >= DAILY_TARGET) perfectDays++;
  }
  statPerfectDays.innerText = perfectDays;
  
  // 3. Weekly completion rate (this week Mon - Sun)
  const today = new Date();
  const currentDayIndex = today.getDay(); // 0 is Sun, 1 is Mon, etc.
  const distanceToMonday = currentDayIndex === 0 ? 6 : currentDayIndex - 1;
  
  const monday = new Date(today);
  monday.setDate(today.getDate() - distanceToMonday);
  
  let weeklyCompletions = 0;
  for (let i = 0; i < 7; i++) {
    const checkDate = new Date(monday);
    checkDate.setDate(monday.getDate() + i);
    const dateStr = getLocalDateString(checkDate);
    weeklyCompletions += state.history[dateStr] || 0;
  }
  
  statWeeklyRate.innerText = `${weeklyCompletions} / 21`;
  
  // 4. Streak Counter
  let streak = 0;
  let streakCheckDate = new Date(today);
  
  // If today hasn't met the target yet, start checking from yesterday
  const todayStr = getLocalDateString(streakCheckDate);
  const todayCount = state.history[todayStr] || 0;
  
  if (todayCount < DAILY_TARGET) {
    streakCheckDate.setDate(streakCheckDate.getDate() - 1);
  }
  
  while (true) {
    const checkStr = getLocalDateString(streakCheckDate);
    const dayCount = state.history[checkStr] || 0;
    
    if (dayCount >= DAILY_TARGET) {
      streak++;
      streakCheckDate.setDate(streakCheckDate.getDate() - 1);
    } else {
      break;
    }
  }
  
  statCurrentStreak.innerText = `${streak} ${streak === 1 ? 'Day' : 'Days'}`;
  
  // Re-draw calendar to display modified states
  renderCalendar();
}

// ==========================================================================
// Triumph Goal Celebration & Confetti Particle Physics
// ==========================================================================
function triggerTriumphCelebration() {
  playCompletionChime();
  
  // Trigger full screen confetti
  const canvas = document.getElementById('celebration-canvas');
  const ctx = canvas.getContext('2d');
  
  // Resize canvas
  canvas.width = window.innerWidth;
  canvas.height = window.innerHeight;
  
  state.confettiActive = true;
  state.confettiParticles = [];
  
  // Spawn 150 confetti particles
  const colors = [
    '#2ecc71', // Neon green
    '#3498db', // Cyan blue
    '#e74c3c', // Red
    '#f1c40f', // Yellow gold
    '#9b59b6', // Violet
    '#e67e22', // Orange
    '#ffd700', // Bright gold
    '#ffffff'  // White shine
  ];
  
  for (let i = 0; i < 150; i++) {
    state.confettiParticles.push({
      x: Math.random() * canvas.width,
      y: Math.random() * -canvas.height - 20, // start above view
      size: Math.random() * 8 + 6,
      color: colors[Math.floor(Math.random() * colors.length)],
      speedY: Math.random() * 5 + 3,
      speedX: Math.random() * 4 - 2,
      rotation: Math.random() * 360,
      rotationSpeed: Math.random() * 10 - 5
    });
  }
  
  // Open congratulatory notification
  const todayStr = getLocalDateString(new Date());
  const completionsToday = state.history[todayStr] || 0;
  
  setTimeout(() => {
    let message = `You completed a 4-hour focus block! Great job.`;
    if (completionsToday === DAILY_TARGET) {
      message = `🎉 Incredible! You've achieved your daily target of 3 blocks today! Keep up the brilliant work.`;
    } else if (completionsToday >= 4) {
      message = `🏆 Supercharged! You completed ${completionsToday} blocks today, exceeding your target. Gold star unlocked! ⭐`;
    }
    
    alert(message); // Standard alert fallback. Easily visible.
  }, 500);
}

function confettiRenderLoop() {
  const canvas = document.getElementById('celebration-canvas');
  if (!canvas) return;
  const ctx = canvas.getContext('2d');
  
  if (state.confettiActive) {
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    
    let activeParticlesCount = 0;
    
    state.confettiParticles.forEach(p => {
      p.y += p.speedY;
      p.x += p.speedX;
      p.rotation += p.rotationSpeed;
      
      if (p.y < canvas.height) {
        activeParticlesCount++;
      }
      
      ctx.save();
      ctx.translate(p.x, p.y);
      ctx.rotate((p.rotation * Math.PI) / 180);
      ctx.fillStyle = p.color;
      ctx.fillRect(-p.size / 2, -p.size / 2, p.size, p.size);
      ctx.restore();
    });
    
    if (activeParticlesCount === 0) {
      state.confettiActive = false;
      ctx.clearRect(0, 0, canvas.width, canvas.height);
    }
  }
  
  requestAnimationFrame(confettiRenderLoop);
}

// Resize canvas on screen scale changes
window.addEventListener('resize', () => {
  const canvas = document.getElementById('celebration-canvas');
  if (canvas && state.confettiActive) {
    canvas.width = window.innerWidth;
    canvas.height = window.innerHeight;
  }
});

// ==========================================================================
// Event Listeners & UI Binder Interactivity
// ==========================================================================
function setupEventListeners() {
  // Timer Controls
  startBtn.addEventListener('click', startTimer);
  pauseBtn.addEventListener('click', pauseTimer);
  resetBtn.addEventListener('click', resetTimer);
  
  // Audio Control
  audioToggleBtn.addEventListener('click', () => {
    state.soundEnabled = !state.soundEnabled;
    initAudioContext();
    updateAudioIcon();
    saveData();
  });
  
  // Calendar Navigation
  prevMonthBtn.addEventListener('click', () => navigateMonth(-1));
  nextMonthBtn.addEventListener('click', () => navigateMonth(1));
  
  // Manual log button (today)
  manualLogTodayBtn.addEventListener('click', () => {
    const todayStr = getLocalDateString(new Date());
    openDayEditorModal(todayStr);
  });
  
  // Day Editor Modal Buttons
  dayModalCloseBtn.addEventListener('click', closeDayEditorModal);
  
  dayModalMinusBtn.addEventListener('click', () => {
    let val = parseInt(dayModalCount.innerText) || 0;
    if (val > 0) {
      val--;
      dayModalCount.innerText = val;
      updateDayModalRewardDisplay(val);
    }
  });
  
  dayModalPlusBtn.addEventListener('click', () => {
    let val = parseInt(dayModalCount.innerText) || 0;
    val++;
    dayModalCount.innerText = val;
    updateDayModalRewardDisplay(val);
  });
  
  dayModalSaveBtn.addEventListener('click', () => {
    if (activeSelectedDayStr) {
      const val = parseInt(dayModalCount.innerText) || 0;
      state.history[activeSelectedDayStr] = val;
      saveData();
      closeDayEditorModal();
      
      // If we manual log a goal hit, celebrate!
      const isToday = activeSelectedDayStr === getLocalDateString(new Date());
      if (isToday && (val === DAILY_TARGET || val === 4)) {
        triggerTriumphCelebration();
      }
    }
  });
  
  // Settings Drawer Toggle
  settingsToggleBtn.addEventListener('click', () => {
    settingsModal.classList.remove('hidden');
  });
  
  settingsCloseBtn.addEventListener('click', () => {
    settingsModal.classList.add('hidden');
  });
  
  
  // Volume Slider
  tickVolumeSlider.addEventListener('input', (e) => {
    const val = parseInt(e.target.value);
    state.volume = val / 100;
    volumeValDisplay.innerText = `${val}%`;
    saveData();
  });
  
  // Close modals when clicking overlay backgrounds
  window.addEventListener('click', (e) => {
    if (e.target === settingsModal) settingsModal.classList.add('hidden');
    if (e.target === dayModal) closeDayEditorModal();
  });
  
  // Debug Utilities
  debugFastForwardBtn.addEventListener('click', () => {
    if (state.timerState === 'RUNNING') {
      state.endTime = Date.now() + 5000; // 5 seconds left
      alert('Timer set to 5 seconds remaining. Watch the completion rewards!');
      settingsModal.classList.add('hidden');
    } else {
      alert('Please start the timer first before fast forwarding!');
    }
  });
  
  debugAddPastDataBtn.addEventListener('click', () => {
    const mockHistory = {};
    const baseDate = new Date();
    
    // Add mock logs for the past 14 days
    for (let i = 1; i <= 14; i++) {
      const pastDate = new Date(baseDate);
      pastDate.setDate(baseDate.getDate() - i);
      const dateStr = getLocalDateString(pastDate);
      
      // Random completions: 0 to 4 blocks
      const rand = Math.floor(Math.random() * 5);
      mockHistory[dateStr] = rand;
    }
    
    state.history = { ...state.history, ...mockHistory };
    saveData();
    alert('Mock history loaded for the last 14 days! Check out your calendar & stats.');
    settingsModal.classList.add('hidden');
  });
  
  debugClearDataBtn.addEventListener('click', () => {
    if (confirm('Are you sure you want to clear all completion logs? This will wipe your history.')) {
      state.history = {};
      resetTimer();
      saveData();
      alert('All local history cleared.');
      settingsModal.classList.add('hidden');
    }
  });
}
