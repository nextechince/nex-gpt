/* ============================================================
   NEXGPT — main.js
   ============================================================ */

import { initializeApp } from 'firebase/app';
import {
  getAuth, onAuthStateChanged, signInWithEmailAndPassword,
  createUserWithEmailAndPassword, signInWithPopup, GoogleAuthProvider,
  signInAnonymously, signOut, sendPasswordResetEmail, updateProfile
} from 'firebase/auth';
import {
  getFirestore, doc, setDoc, getDoc, collection, query, where,
  orderBy, onSnapshot, addDoc, updateDoc, deleteDoc, getDocs, serverTimestamp
} from 'firebase/firestore';

/* ============================================================
   FIREBASE CONFIG (from .env via Vite)
   ============================================================ */
const firebaseConfig = {
  apiKey: import.meta.env.VITE_FIREBASE_API_KEY,
  authDomain: import.meta.env.VITE_FIREBASE_AUTH_DOMAIN,
  projectId: import.meta.env.VITE_FIREBASE_PROJECT_ID,
  storageBucket: import.meta.env.VITE_FIREBASE_STORAGE_BUCKET,
  messagingSenderId: import.meta.env.VITE_FIREBASE_MESSAGING_SENDER_ID,
  appId: import.meta.env.VITE_FIREBASE_APP_ID
};
const OPENROUTER_KEY = import.meta.env.VITE_OPENROUTER_API_KEY || '';

if (!firebaseConfig.apiKey || !OPENROUTER_KEY) {
  document.getElementById('app').innerHTML = `
    <div style="font-family:system-ui;padding:40px;max-width:640px;margin:60px auto;border:1px solid #fecaca;background:#fef2f2;color:#991b1b;border-radius:12px;line-height:1.6">
      <h2 style="margin:0 0 12px">Missing env vars</h2>
      <p>Add these to your <code>.env</code> file and to Vercel:</p>
      <ul style="margin:12px 0;padding-left:20px">
        <li><code>VITE_FIREBASE_API_KEY</code> and the rest of the Firebase config</li>
        <li><code>VITE_OPENROUTER_API_KEY</code></li>
      </ul>
      <p>Then reload.</p>
    </div>`;
  throw new Error('Missing env vars');
}

const firebaseApp = initializeApp(firebaseConfig);
const auth = getAuth(firebaseApp);
const db = getFirestore(firebaseApp);
const googleProvider = new GoogleAuthProvider();

/* ============================================================
   CONSTANTS
   ============================================================ */
const API_URL = 'https://openrouter.ai/api/v1/chat/completions';
const GUEST_MESSAGE_LIMIT = 20;
const GUEST_MODEL_ID = 'meta-llama/llama-3.3-70b-instruct:free';
const MAX_FILES = 15;
const MAX_FILE_BYTES = 10 * 1024 * 1024;

const DEFAULT_SYSTEM_PROMPT =
  "You are NEXGPT, an advanced AI assistant powered by DeepSeek. You are helpful, harmless, honest, and thorough. You write, debug, and explain code in any language, always wrapping code in triple backticks with the language tag. You format responses with markdown. You are direct, clear, and avoid filler. Admit uncertainty when you are unsure. When web search is enabled, acknowledge that you are providing current information.";

const SYSTEM_PRESETS = {
  default: DEFAULT_SYSTEM_PROMPT,
  coder: "You are NEXGPT in Coder mode. You write clean, production-quality code with error handling, types where applicable, and concise explanations. Always wrap code in triple backticks with the language tag. Prefer modern idioms. Point out bugs and edge cases. Be direct.",
  writer: "You are NEXGPT in Writer mode. You craft clear, evocative prose. You adapt tone to the request — formal, casual, poetic, technical. You avoid clichés and filler. You favor strong verbs and concrete nouns.",
  teacher: "You are NEXGPT in Teacher mode. You explain concepts step by step, from first principles, using analogies and examples. You check understanding by asking short follow-up questions. You never talk down to the learner.",
  concise: "You are NEXGPT in Concise mode. You answer in the fewest words possible without losing accuracy. No preamble, no disclaimers, no filler. Use bullet points when helpful. If a one-word answer will do, give a one-word answer."
};

/* ============================================================
   MODELS — all free on OpenRouter
   ============================================================ */
const MODELS = [
  { id: 'meta-llama/llama-3.3-70b-instruct:free', name: 'Llama 3.3 70B', desc: 'Reliable general-purpose model. Default for guests.', badges: ['free','fast'], vision: false, audio: false },
  { id: 'qwen/qwen3-coder:free', name: 'Qwen3 Coder 480B', desc: 'Frontier coding model. 262K context.', badges: ['free','fast'], vision: false, audio: false },
  { id: 'qwen/qwen3-next-80b-a3b-instruct:free', name: 'Qwen3 Next 80B', desc: 'Strong general reasoning. 262K context.', badges: ['free'], vision: false, audio: false },
  { id: 'google/gemma-4-26b-a4b-it:free', name: 'Gemma 4 26B', desc: 'Google model with vision. 262K context.', badges: ['free','vision','fast'], vision: true, audio: false },
  { id: 'google/gemma-4-31b-it:free', name: 'Gemma 4 31B', desc: 'Dense Google model with vision and strong reasoning.', badges: ['free','vision'], vision: true, audio: false },
  { id: 'nvidia/nemotron-3-nano-omni-30b-a3b-reasoning:free', name: 'Nemotron 3 Nano Omni', desc: 'NVIDIA reasoning model with vision, video and audio input.', badges: ['free','vision','reason'], vision: true, audio: true },
  { id: 'stepfun/step-3.5-flash:free', name: 'Step 3.5 Flash', desc: 'Fast multimodal model. 256K context.', badges: ['free','fast'], vision: false, audio: false },
  { id: 'z-ai/glm-4.5-air:free', name: 'GLM 4.5 Air', desc: 'Efficient general model. Good for everyday tasks.', badges: ['free'], vision: false, audio: false },
  { id: 'openai/gpt-oss-120b:free', name: 'gpt-oss-120b', desc: 'OpenAI open-weights model. Strong general use.', badges: ['free'], vision: false, audio: false },
  { id: 'openrouter/free', name: 'Auto (Free Router)', desc: 'Automatically picks the best available free model.', badges: ['free'], vision: true, audio: false }
];

/* ============================================================
   STATE
   ============================================================ */
const state = {
  user: null,
  isGuest: false,
  chats: [],
  activeChatId: null,
  activeModelId: MODELS[0].id,
  streaming: false,
  abortController: null,
  attachments: [],
  webSearch: false,
  pendingGuestCount: 0,
  unsubscribeChats: null,
  searchQuery: '',
  settings: {
    systemPrompt: DEFAULT_SYSTEM_PROMPT,
    preset: 'default',
    temperature: 0.7,
    maxTokens: 2048,
    accent: 'default',
    autoTTS: false,
    voiceURI: ''
  }
};

/* ============================================================
   DOM HELPERS
   ============================================================ */
const $ = (id) => document.getElementById(id);
const $$ = (sel, root = document) => root.querySelectorAll(sel);
const el = (tag, cls, html) => {
  const e = document.createElement(tag);
  if (cls) e.className = cls;
  if (html != null) e.innerHTML = html;
  return e;
};
const esc = (s) => String(s ?? '')
  .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
  .replace(/"/g, '&quot;').replace(/'/g, '&#039;');
const uid = () => Date.now().toString(36) + Math.random().toString(36).slice(2, 8);
const clamp = (n, a, b) => Math.max(a, Math.min(b, n));
const fmtBytes = (b) => {
  if (b < 1024) return b + ' B';
  if (b < 1024 * 1024) return (b / 1024).toFixed(1) + ' KB';
  return (b / 1024 / 1024).toFixed(1) + ' MB';
};

/* ============================================================
   TOASTS
   ============================================================ */
function toast(message, type = '') {
  const stack = $('toastStack');
  const t = el('div', 'toast ' + type);
  t.innerHTML = `<i class="fa-solid ${type === 'error' ? 'fa-circle-exclamation' : type === 'success' ? 'fa-circle-check' : 'fa-circle-info'}"></i><span>${esc(message)}</span>`;
  stack.appendChild(t);
  setTimeout(() => {
    t.classList.add('out');
    setTimeout(() => t.remove(), 220);
  }, 2800);
}

/* ============================================================
   SETTINGS PERSISTENCE
   ============================================================ */
function loadSettings() {
  try {
    const raw = localStorage.getItem('nexgpt_settings');
    if (raw) Object.assign(state.settings, JSON.parse(raw));
  } catch (_) {}
  applyAccent(state.settings.accent);
}

function saveSettings() {
  try { localStorage.setItem('nexgpt_settings', JSON.stringify(state.settings)); } catch (_) {}
}

function applyAccent(accent) {
  document.documentElement.dataset.accent = accent || 'default';
  $$('#accentPicker .accent-dot').forEach((d) => d.classList.toggle('active', d.dataset.accent === accent));
}

/* ============================================================
   AUTH UI
   ============================================================ */
function showScreen(name) {
  $('splash').classList.toggle('hidden', name !== 'splash');
  $('auth').classList.toggle('hidden', name !== 'auth');
  $('main').classList.toggle('hidden', name !== 'main');
}

function setAuthTab(tab) {
  const isSignin = tab === 'signin';
  $('tabSignin').classList.toggle('active', isSignin);
  $('tabSignup').classList.toggle('active', !isSignin);
  $('tabSignin').setAttribute('aria-selected', isSignin);
  $('tabSignup').setAttribute('aria-selected', !isSignin);
  $('signinForm').classList.toggle('hidden', !isSignin);
  $('signupForm').classList.toggle('hidden', isSignin);
  $('authTitle').textContent = isSignin ? 'Welcome back' : 'Create your account';
  $('authSubtitle').textContent = isSignin ? 'Sign in to continue to NEXGPT' : 'Free forever. No credit card.';
  showAuthError('');
}

function showAuthError(msg) {
  const box = $('authError');
  if (!msg) { box.classList.add('hidden'); box.textContent = ''; return; }
  box.textContent = msg;
  box.classList.remove('hidden');
}

function friendlyAuthError(code, fallback) {
  const map = {
    'auth/invalid-email': 'That email address looks invalid.',
    'auth/user-not-found': 'No account with that email.',
    'auth/wrong-password': 'Wrong password.',
    'auth/invalid-credential': 'Wrong email or password.',
    'auth/email-already-in-use': 'That email is already registered.',
    'auth/weak-password': 'Password should be at least 8 characters.',
    'auth/too-many-requests': 'Too many attempts. Try again later.',
    'auth/network-request-failed': 'Network error. Check your connection.',
    'auth/popup-closed-by-user': 'Google sign-in was cancelled.',
    'auth/popup-blocked': 'Popup blocked. Allow popups and try again.',
    'auth/operation-not-allowed': 'This sign-in method is not enabled in Firebase.'
  };
  return map[code] || fallback || 'Something went wrong. Try again.';
}

/* ============================================================
   AUTH FLOW
   ============================================================ */
async function doSignup(e) {
  e.preventDefault();
  showAuthError('');
  const username = $('signupUsername').value.trim();
  const email = $('signupEmail').value.trim();
  const password = $('signupPassword').value;
  const confirm = $('signupPasswordConfirm').value;

  if (!/^[A-Za-z0-9_]{3,24}$/.test(username)) return showAuthError('Username must be 3–24 chars, letters/numbers/underscore.');
  if (password.length < 8) return showAuthError('Password must be at least 8 characters.');
  if (password !== confirm) return showAuthError('Passwords do not match.');

  $('signupSubmit').disabled = true;
  try {
    const guestCount = state.pendingGuestCount;
    const cred = await createUserWithEmailAndPassword(auth, email, password);
    await updateProfile(cred.user, { displayName: username });
    await setDoc(doc(db, 'users', cred.user.uid), {
      uid: cred.user.uid,
      username,
      email,
      createdAt: serverTimestamp()
    });
    // migrate guest chats if any
    if (guestCount > 0) {
      await migrateGuestChats(cred.user.uid);
      toast('Your guest chats were saved to your account.', 'success');
    }
    toast('Account created.', 'success');
  } catch (err) {
    showAuthError(friendlyAuthError(err.code, err.message));
  } finally {
    $('signupSubmit').disabled = false;
  }
}

async function doSignin(e) {
  e.preventDefault();
  showAuthError('');
  const email = $('signinEmail').value.trim();
  const password = $('signinPassword').value;
  $('signinSubmit').disabled = true;
  try {
    const guestCount = state.pendingGuestCount;
    const cred = await signInWithEmailAndPassword(auth, email, password);
    if (guestCount > 0) {
      await migrateGuestChats(cred.user.uid);
      toast('Your guest chats were saved to your account.', 'success');
    }
    toast('Signed in.', 'success');
  } catch (err) {
    showAuthError(friendlyAuthError(err.code, err.message));
  } finally {
    $('signinSubmit').disabled = false;
  }
}

async function doGoogle() {
  showAuthError('');
  try {
    const guestCount = state.pendingGuestCount;
    const cred = await signInWithPopup(auth, googleProvider);
    // ensure user profile
    const ref = doc(db, 'users', cred.user.uid);
    const snap = await getDoc(ref);
    if (!snap.exists()) {
      await setDoc(ref, {
        uid: cred.user.uid,
        username: cred.user.displayName || 'user',
        email: cred.user.email || '',
        createdAt: serverTimestamp()
      });
    }
    if (guestCount > 0) {
      await migrateGuestChats(cred.user.uid);
      toast('Your guest chats were saved to your account.', 'success');
    }
    toast('Signed in with Google.', 'success');
  } catch (err) {
    showAuthError(friendlyAuthError(err.code, err.message));
  }
}

async function doGuest() {
  showAuthError('');
  try {
    await signInAnonymously(auth);
    toast('Continuing as guest.', 'success');
  } catch (err) {
    showAuthError(friendlyAuthError(err.code, err.message));
  }
}

async function doForgot() {
  const email = $('signinEmail').value.trim();
  if (!email) return showAuthError('Enter your email first, then click Forgot password.');
  try {
    await sendPasswordResetEmail(auth, email);
    toast('Password reset email sent.', 'success');
  } catch (err) {
    showAuthError(friendlyAuthError(err.code, err.message));
  }
}

async function doSignout() {
  try {
    await signOut(auth);
    toast('Signed out.', 'success');
  } catch (err) {
    toast('Could not sign out.', 'error');
  }
}

/* ============================================================
   AUTH STATE
   ============================================================ */
function isAnonymousUser(u) { return u && u.isAnonymous; }

function onUserChanged(user) {
  if (state.unsubscribeChats) { state.unsubscribeChats(); state.unsubscribeChats = null; }
  state.user = user;
  state.isGuest = isAnonymousUser(user);

  if (!user) {
    state.chats = [];
    state.activeChatId = null;
    showScreen('auth');
    return;
  }

  // load profile + chats
  ensureUserProfile(user).then(() => {
    showScreen('main');
    renderUserCard();
    renderGuestBanner();
    subscribeChats(user.uid);
    const first = state.chats[0];
    if (first) setActiveChat(first.id);
    else createChat();
  }).catch((err) => {
    console.error(err);
    toast('Failed to load your data.', 'error');
    showScreen('auth');
  });
}

async function ensureUserProfile(user) {
  const ref = doc(db, 'users', user.uid);
  const snap = await getDoc(ref);
  if (!snap.exists()) {
    await setDoc(ref, {
      uid: user.uid,
      username: user.isAnonymous ? 'Guest' : (user.displayName || 'user'),
      email: user.email || '',
      createdAt: serverTimestamp()
    });
  }
}

/* ============================================================
   CHAT FIRESTORE SUBSCRIPTION
   ============================================================ */
function chatsCol(uid) { return collection(db, 'users', uid, 'chats'); }

function subscribeChats(uid) {
  const q = query(chatsCol(uid), orderBy('updatedAt', 'desc'));
  state.unsubscribeChats = onSnapshot(q, (snap) => {
    state.chats = snap.docs.map((d) => ({ id: d.id, ...d.data() }));
    if (!state.activeChatId && state.chats.length) {
      state.activeChatId = state.chats[0].id;
    }
    renderChatList();
    renderMessages();
    updateGuestBannerCount();
  }, (err) => {
    console.error('Chat subscribe error:', err);
  });
}

async function createChat() {
  if (!state.user) return;
  const ref = doc(chatsCol(state.user.uid));
  const newChat = {
    title: 'New chat',
    model: state.activeModelId,
    messages: [],
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };
  await setDoc(ref, newChat);
  state.activeChatId = ref.id;
  return ref.id;
}

async function deleteChat(chatId) {
  if (!state.user) return;
  await deleteDoc(doc(db, 'users', state.user.uid, 'chats', chatId));
  if (state.activeChatId === chatId) {
    const remaining = state.chats.filter((c) => c.id !== chatId);
    state.activeChatId = remaining[0]?.id || null;
  }
}

async function updateChat(chatId, patch) {
  if (!state.user) return;
  await updateDoc(doc(db, 'users', state.user.uid, 'chats', chatId), {
    ...patch,
    updatedAt: serverTimestamp()
  });
}

async function clearAllChats() {
  if (!state.user) return;
  const snap = await getDocs(chatsCol(state.user.uid));
  await Promise.all(snap.docs.map((d) => deleteDoc(d.ref)));
  state.activeChatId = null;
  createChat();
  toast('All chats deleted.', 'success');
}

/* ============================================================
   GUEST MIGRATION
   ============================================================ */
async function migrateGuestChats(newUid) {
  try {
    // Pull guest chats from localStorage (guest fallback), then push to Firestore
    const raw = localStorage.getItem('nexgpt_guest_chats');
    if (!raw) return;
    const guestChats = JSON.parse(raw);
    if (!Array.isArray(guestChats) || !guestChats.length) return;
    for (const c of guestChats) {
      const ref = doc(chatsCol(newUid));
      await setDoc(ref, {
        title: c.title || 'New chat',
        model: c.model || GUEST_MODEL_ID,
        messages: c.messages || [],
        createdAt: serverTimestamp(),
        updatedAt: serverTimestamp()
      });
    }
    localStorage.removeItem('nexgpt_guest_chats');
    localStorage.removeItem('nexgpt_guest_count');
  } catch (e) { console.warn('Migration failed:', e); }
}

/* ============================================================
   SIDEBAR RENDER
   ============================================================ */
function getFilteredChats() {
  const q = state.searchQuery.trim().toLowerCase();
  if (!q) return state.chats;
  return state.chats.filter((c) => {
    if ((c.title || '').toLowerCase().includes(q)) return true;
    if (Array.isArray(c.messages)) {
      return c.messages.some((m) => (m.content || '').toLowerCase().includes(q));
    }
    return false;
  });
}

function renderChatList() {
  const list = $('chatList');
  list.innerHTML = '';
  const chats = getFilteredChats();

  if (!chats.length) {
    list.appendChild(el('div', 'chat-empty', state.searchQuery ? 'No chats match.' : 'No chats yet. Start one below.'));
    return;
  }

  // Group by date
  const groups = { Today: [], Yesterday: [], 'This week': [], Older: [] };
  const now = Date.now();
  chats.forEach((c) => {
    const t = c.updatedAt?.toMillis ? c.updatedAt.toMillis() : (c.updatedAt || 0);
    const diff = now - t;
    const day = 86400000;
    if (diff < day) groups.Today.push(c);
    else if (diff < 2 * day) groups.Yesterday.push(c);
    else if (diff < 7 * day) groups['This week'].push(c);
    else groups.Older.push(c);
  });

  Object.entries(groups).forEach(([label, arr]) => {
    if (!arr.length) return;
    list.appendChild(el('div', 'chat-group-label', esc(label)));
    arr.forEach((c) => list.appendChild(buildChatItem(c)));
  });
}

function buildChatItem(chat) {
  const item = el('div', 'chat-item' + (chat.id === state.activeChatId ? ' active' : ''));
  item.dataset.id = chat.id;

  const icon = el('i', 'fa-solid fa-comment');

  const title = el('span', 'chat-item-title');
  title.textContent = chat.title || 'New chat';

  const actions = el('div', 'chat-item-actions');
  const editBtn = el('button', 'chat-item-action', '<i class="fa-solid fa-pen"></i>');
  editBtn.title = 'Rename';
  editBtn.addEventListener('click', (e) => { e.stopPropagation(); startRename(chat, item, title); });
  const delBtn = el('button', 'chat-item-action del', '<i class="fa-solid fa-trash-can"></i>');
  delBtn.title = 'Delete';
  delBtn.addEventListener('click', async (e) => {
    e.stopPropagation();
    if (!confirm('Delete this chat?')) return;
    await deleteChat(chat.id);
    toast('Chat deleted.');
  });
  actions.appendChild(editBtn);
  actions.appendChild(delBtn);

  item.appendChild(icon);
  item.appendChild(title);
  item.appendChild(actions);

  item.addEventListener('click', () => {
    setActiveChat(chat.id);
    closeSidebarMobile();
  });

  return item;
}

function startRename(chat, item, titleEl) {
  const input = el('input', 'chat-item-title-input');
  input.value = chat.title || '';
  item.replaceChild(input, titleEl);
  input.focus();
  input.select();

  const finish = async (save) => {
    const val = input.value.trim();
    item.replaceChild(titleEl, input);
    if (save && val && val !== chat.title) {
      await updateChat(chat.id, { title: val });
    }
  };

  input.addEventListener('blur', () => finish(true));
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter') { e.preventDefault(); input.blur(); }
    if (e.key === 'Escape') { e.preventDefault(); finish(false); }
  });
  input.addEventListener('click', (e) => e.stopPropagation());
}

function setActiveChat(id) {
  state.activeChatId = id;
  renderChatList();
  renderMessages();
  scrollToBottom();
}

/* ============================================================
   GUEST BANNER / COUNT
   ============================================================ */
function getGuestCount() {
  return parseInt(localStorage.getItem('nexgpt_guest_count') || '0', 10) || 0;
}
function setGuestCount(n) {
  localStorage.setItem('nexgpt_guest_count', String(n));
  updateGuestBannerCount();
}
function updateGuestBannerCount() {
  if (!state.isGuest) return;
  const used = getGuestCount();
  const left = Math.max(0, GUEST_MESSAGE_LIMIT - used);
  $('guestBannerMsg').textContent = `${left} of ${GUEST_MESSAGE_LIMIT} messages left. Sign in to keep your chats.`;
}
function renderGuestBanner() {
  $('guestBanner').classList.toggle('hidden', !state.isGuest);
  if (state.isGuest) updateGuestBannerCount();
}

/* ============================================================
   USER CARD
   ============================================================ */
function renderUserCard() {
  const u = state.user;
  const name = u?.displayName || (u?.isAnonymous ? 'Guest' : (u?.email?.split('@')[0] || 'User'));
  const sub = u?.isAnonymous ? 'Guest' : (u?.email || '');
  $('userName').textContent = name;
  $('userSub').textContent = sub;
  const av = $('userAvatar');
  if (u?.isAnonymous) {
    av.classList.remove('has-color');
    av.style.background = '';
    av.innerHTML = '<i class="fa-solid fa-user-secret"></i>';
  } else {
    const color = colorFromString(u.uid);
    av.classList.add('has-color');
    av.style.background = color;
    av.textContent = (name[0] || 'U').toUpperCase();
  }
  $('signOutBtn').classList.toggle('hidden', !!u?.isAnonymous);
  $('upgradeGuestBtn').classList.toggle('hidden', !u?.isAnonymous);
}

function colorFromString(s) {
  let hash = 0;
  for (let i = 0; i < s.length; i++) hash = s.charCodeAt(i) + ((hash << 5) - hash);
  const hue = Math.abs(hash) % 360;
  return `hsl(${hue}, 60%, 45%)`;
}

/* ============================================================
   MODEL MENU
   ============================================================ */
function renderModelMenu() {
  const menu = $('modelMenu');
  menu.innerHTML = '';
  const current = MODELS.find((m) => m.id === state.activeModelId) || MODELS[0];

  const groupLabel = el('div', 'model-menu-group', state.isGuest ? 'Available to guests' : 'Free models');
  menu.appendChild(groupLabel);

  const available = state.isGuest ? MODELS.filter((m) => m.id === GUEST_MODEL_ID) : MODELS;

  available.forEach((m) => {
    const item = el('button', 'model-menu-item' + (m.id === state.activeModelId ? ' selected' : ''));
    item.setAttribute('role', 'menuitem');

    const badges = m.badges.map((b) => {
      const label = b === 'free' ? 'FREE' : b === 'vision' ? 'VISION' : b === 'reason' ? 'REASON' : b === 'fast' ? 'FAST' : b === 'audio' ? 'AUDIO' : b.toUpperCase();
      return `<span class="model-item-badge ${b}">${label}</span>`;
    }).join('');

    item.innerHTML = `
      <div class="model-item-body">
        <div class="model-item-name">${esc(m.name)} ${badges}</div>
        <div class="model-item-desc">${esc(m.desc)}</div>
      </div>
      <i class="fa-solid fa-check model-item-check"></i>
    `;

    item.addEventListener('click', () => {
      state.activeModelId = m.id;
      $('modelLabel').textContent = m.name;
      const chat = getActiveChat();
      if (chat) updateChat(chat.id, { model: m.id });
      menu.classList.add('hidden');
      $('modelSelectorBtn').setAttribute('aria-expanded', 'false');
      toast(`Switched to ${m.name}`);
    });

    menu.appendChild(item);
  });
}

function updateModelLabel() {
  const m = MODELS.find((x) => x.id === state.activeModelId);
  $('modelLabel').textContent = m?.name || 'Select model';
}

/* ============================================================
   ACTIVE CHAT
   ============================================================ */
function getActiveChat() {
  return state.chats.find((c) => c.id === state.activeChatId) || null;
}

/* ============================================================
   MESSAGE RENDER
   ============================================================ */
function renderMessages() {
  const wrap = $('messages');
  wrap.innerHTML = '';
  const chat = getActiveChat();

  if (!chat || !chat.messages || chat.messages.length === 0) {
    renderEmptyState();
    return;
  }

  chat.messages.forEach((msg, idx) => {
    if (msg.role === 'user') wrap.appendChild(buildUserMessage(msg));
    else if (msg.role === 'assistant') wrap.appendChild(buildAssistantMessage(msg, idx, chat));
    else if (msg.role === 'error') wrap.appendChild(buildErrorMessage(msg));
  });

  attachCodeCopyButtons();
  scrollToBottom();
}

function renderEmptyState() {
  const wrap = $('messages');
  const box = el('div', 'empty-state');
  box.innerHTML = `
    <div class="logo-icon"><i class="fa-solid fa-bolt"></i></div>
    <h2>How can I help you today?</h2>
    <p>Ask me anything — I can write code, explain concepts, brainstorm ideas, and much more.</p>
    <div class="suggestion-chips">
      <button class="chip" data-suggest="Write a haiku about rain">Write a haiku about rain</button>
      <button class="chip" data-suggest="Explain quantum computing like I'm five">Explain quantum computing</button>
      <button class="chip" data-suggest="Debug this JavaScript function that returns NaN">Debug my code</button>
      <button class="chip" data-suggest="Give me 5 ideas for a weekend project in Python">Weekend project ideas</button>
    </div>
  `;
  box.querySelectorAll('.chip').forEach((c) => {
    c.addEventListener('click', () => {
      $('chatInput').value = c.dataset.suggest;
      autoResizeTextarea();
      updateSendButton();
      $('chatInput').focus();
    });
  });
  wrap.appendChild(box);
}

function buildUserMessage(msg) {
  const row = el('div', 'msg-row user');
  const bubble = el('div', 'user-bubble');

  if (msg.attachments && msg.attachments.length) {
    const attWrap = el('div', 'user-bubble-attachments');
    msg.attachments.forEach((a) => {
      if (a.kind === 'image' && a.dataUrl) {
        const img = el('img', 'user-image');
        img.src = a.dataUrl;
        img.alt = a.name || 'image';
        img.loading = 'lazy';
        attWrap.appendChild(img);
      } else {
        const card = el('div', 'user-bubble-attachment');
        card.innerHTML = `<i class="fa-solid ${a.kind === 'audio' ? 'fa-microphone-lines' : a.kind === 'pdf' ? 'fa-file-pdf' : 'fa-file-lines'}"></i><span class="user-bubble-attachment-name">${esc(a.name || 'file')}</span>`;
        attWrap.appendChild(card);
      }
    });
    bubble.appendChild(attWrap);
  }

  if (msg.content) {
    const text = el('div');
    text.textContent = msg.content;
    bubble.appendChild(text);
  }

  row.appendChild(bubble);
  return row;
}

function buildAssistantMessage(msg, idx, chat) {
  const row = el('div', 'msg-row ai');
  const avatar = el('div', 'ai-avatar', '<i class="fa-solid fa-robot"></i>');
  const col = el('div');
  col.style.cssText = 'display:flex;flex-direction:column;flex:1;min-width:0';

  const content = el('div', 'ai-content');
  if (msg.streaming && !msg.content) {
    content.innerHTML = '<div class="typing-indicator"><span></span><span></span><span></span></div>';
  } else {
    content.innerHTML = renderMarkdown(msg.content || '');
  }

  const actions = el('div', 'msg-actions');
  const copyBtn = makeMsgAction('fa-copy', 'Copy', () => {
    navigator.clipboard.writeText(msg.content || '');
    toast('Copied.', 'success');
  });
  const regenBtn = makeMsgAction('fa-rotate-right', 'Regenerate', () => regenerateMessage(chat, idx));
  const upBtn = makeMsgAction('fa-thumbs-up', 'Good response', (b) => b.classList.toggle('active'));
  const downBtn = makeMsgAction('fa-thumbs-down', 'Bad response', (b) => b.classList.toggle('active'));
  const volBtn = makeMsgAction('fa-volume-high', 'Read aloud', () => speakText(msg.content || ''));

  actions.appendChild(copyBtn);
  actions.appendChild(regenBtn);
  actions.appendChild(upBtn);
  actions.appendChild(downBtn);
  actions.appendChild(volBtn);

  // Version nav
  if (msg.versions && msg.versions.length > 1) {
    const nav = el('div', 'version-nav');
    const prev = el('button', '', '<i class="fa-solid fa-chevron-left"></i>');
    const label = el('span', 'v-label', `${(msg.activeVersion || 0) + 1} / ${msg.versions.length}`);
    const next = el('button', '', '<i class="fa-solid fa-chevron-right"></i>');
    prev.disabled = (msg.activeVersion || 0) <= 0;
    next.disabled = (msg.activeVersion || 0) >= msg.versions.length - 1;
    prev.addEventListener('click', () => switchVersion(chat, idx, -1));
    next.addEventListener('click', () => switchVersion(chat, idx, +1));
    nav.appendChild(prev); nav.appendChild(label); nav.appendChild(next);
    actions.appendChild(nav);
  }

  col.appendChild(content);
  col.appendChild(actions);
  row.appendChild(avatar);
  row.appendChild(col);
  return row;
}

function makeMsgAction(icon, title, onClick) {
  const b = el('button', '', `<i class="fa-solid ${icon}"></i>`);
  b.title = title;
  b.addEventListener('click', () => onClick(b));
  return b;
}

function buildErrorMessage(msg) {
  const row = el('div', 'msg-row ai');
  const avatar = el('div', 'ai-avatar', '<i class="fa-solid fa-robot"></i>');
  const col = el('div');
  col.style.cssText = 'flex:1;min-width:0';
  const box = el('div', 'error-bubble');
  box.innerHTML = `<i class="fa-solid fa-circle-exclamation"></i><span>${esc(msg.content || 'Something went wrong.')}</span><button type="button">Retry</button>`;
  box.querySelector('button').addEventListener('click', () => retryLast());
  col.appendChild(box);
  row.appendChild(avatar);
  row.appendChild(col);
  return row;
}

function attachCodeCopyButtons() {
  $$('.code-copy-btn').forEach((b) => {
    b.addEventListener('click', () => {
      const code = decodeURIComponent(b.dataset.code || '');
      navigator.clipboard.writeText(code);
      b.innerHTML = '<i class="fa-solid fa-check"></i>';
      setTimeout(() => { b.innerHTML = '<i class="fa-solid fa-copy"></i>'; }, 1200);
    });
  });
}

/* ============================================================
   MARKDOWN
   ============================================================ */
function renderMarkdown(text) {
  if (!text) return '';
  const parts = [];
  const re = /```(\w*)\n?([\s\S]*?)```/g;
  let last = 0, m;
  while ((m = re.exec(text))) {
    if (m.index > last) parts.push({ t: 'text', c: text.slice(last, m.index) });
    parts.push({ t: 'code', lang: m[1] || 'text', c: m[2].replace(/\n$/, '') });
    last = m.index + m[0].length;
  }
  if (last < text.length) parts.push({ t: 'text', c: text.slice(last) });

  return parts.map((p) => {
    if (p.t === 'code') {
      return `<div class="code-block">
        <div class="code-block-header">
          <span class="code-lang">${esc(p.lang)}</span>
          <button class="code-copy-btn" data-code="${encodeURIComponent(p.c)}"><i class="fa-solid fa-copy"></i></button>
        </div>
        <pre><code>${esc(p.c)}</code></pre>
      </div>`;
    }
    return renderTextMarkdown(p.c);
  }).join('');
}

function renderTextMarkdown(text) {
  let h = esc(text);
  h = h.replace(/`([^`]+)`/g, '<code class="inline-code">$1</code>');
  h = h.replace(/^### (.+)$/gm, '<h3>$1</h3>');
  h = h.replace(/^## (.+)$/gm, '<h2>$1</h2>');
  h = h.replace(/^# (.+)$/gm, '<h1>$1</h1>');
  h = h.replace(/\*\*([^*]+)\*\*/g, '<strong>$1</strong>');
  h = h.replace(/(^|[^*])\*([^*]+)\*/g, '$1<em>$2</em>');
  h = h.replace(/^> (.+)$/gm, '<blockquote>$1</blockquote>');
  h = h.replace(/\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/g, '<a href="$2" target="_blank" rel="noopener noreferrer">$1</a>');

  // Lists
  h = h.replace(/^\s*[-*]\s+(.+)$/gm, '<li>$1</li>');
  h = h.replace(/(<li>[\s\S]*?<\/li>)(?![\s\S]*?<li>)/g, (match) => {
    if (match.includes('<ul>')) return match;
    return '<ul>' + match + '</ul>';
  });
  // Simpler: wrap consecutive <li> blocks
  h = h.replace(/(?:^|\n)((?:<li>.*<\/li>\n?)+)/g, (mm, list) => '\n<ul>' + list + '</ul>');

  const blocks = h.split(/\n{2,}/);
  return blocks.map((b) => {
    const t = b.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|li|pre|div|blockquote)/i.test(t)) return t;
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).join('');
}

/* ============================================================
   SCROLL
   ============================================================ */
function scrollToBottom() {
  const w = $('messagesWrap');
  requestAnimationFrame(() => { w.scrollTop = w.scrollHeight; });
}
function isNearBottom() {
  const w = $('messagesWrap');
  return w.scrollHeight - w.scrollTop - w.clientHeight < 120;
}

/* ============================================================
   INPUT / TEXTAREA
   ============================================================ */
function autoResizeTextarea() {
  const t = $('chatInput');
  t.style.height = 'auto';
  t.style.height = '0px';
  const max = 144;
  const h = Math.min(t.scrollHeight, max);
  t.style.height = h + 'px';
  t.style.overflowY = t.scrollHeight > max ? 'auto' : 'hidden';
}
function resetTextarea() {
  const t = $('chatInput');
  t.style.height = '23px';
  t.style.overflowY = 'hidden';
}
function updateSendButton() {
  const t = $('chatInput');
  const has = t.value.trim().length > 0;
  $('sendBtn').disabled = !has || state.streaming;
  $('stopBtn').classList.toggle('hidden', !state.streaming);
  $('sendBtn').classList.toggle('hidden', state.streaming);
  updateTokenCounter();
}
function estimateTokens(str) {
  if (!str) return 0;
  return Math.ceil(str.length / 4);
}
function updateTokenCounter() {
  const t = $('chatInput').value || '';
  const n = estimateTokens(t);
  $('tokenCounter').textContent = '~' + n + ' tokens';
}

/* ============================================================
   SEND / STREAM
   ============================================================ */
async function handleSend() {
  const input = $('chatInput');
  const text = input.value.trim();
  if (!text && state.attachments.length === 0) return;
  if (state.streaming) return;

  const chat = getActiveChat();
  if (!chat) return;

  // guest limit
  if (state.isGuest) {
    const used = getGuestCount();
    if (used >= GUEST_MESSAGE_LIMIT) {
      $('guestLimitModal').classList.remove('hidden');
      return;
    }
    // force guest model
    if (state.activeModelId !== GUEST_MODEL_ID) {
      state.activeModelId = GUEST_MODEL_ID;
      updateModelLabel();
    }
  }

  // vision check — auto-switch
  const hasVision = state.attachments.some((a) => a.kind === 'image');
  const hasAudio = state.attachments.some((a) => a.kind === 'audio');
  if (hasVision || hasAudio) {
    const current = MODELS.find((m) => m.id === state.activeModelId);
    const needsVision = hasVision && !current?.vision;
    const needsAudio = hasAudio && !current?.audio;
    if (needsVision || needsAudio) {
      const fallback = MODELS.find((m) => (hasAudio ? m.audio : m.vision));
      if (fallback) {
        state.activeModelId = fallback.id;
        updateModelLabel();
        toast(`Switched to ${fallback.name} for the attachment.`);
      } else {
        toast('No model can handle that attachment.', 'error');
        return;
      }
    }
  }

  const userMsg = {
    role: 'user',
    content: text,
    attachments: state.attachments.map((a) => ({
      kind: a.kind,
      name: a.name,
      size: a.size,
      dataUrl: a.kind === 'image' ? a.dataUrl : null,
      textContent: a.textContent || null
    }))
  };

  const messages = [...(chat.messages || []), userMsg];
  const patch = {
    messages,
    model: state.activeModelId
  };
  if ((chat.messages || []).filter((m) => m.role === 'user').length === 0) {
    patch.title = (text || 'Attachment').slice(0, 40);
  }

  // clear input immediately
  input.value = '';
  state.attachments = [];
  renderAttachTray();
  resetTextarea();
  updateSendButton();

  await updateChat(chat.id, patch);
  if (state.isGuest) setGuestCount(getGuestCount() + 1);

  // Auto-title after first exchange
  if (patch.title) setTimeout(() => autoTitle(chat.id), 1500);

  await streamAssistant(chat.id);
}

async function streamAssistant(chatId) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat) return;

  state.streaming = true;
  updateSendButton();

  const assistantMsg = { role: 'assistant', content: '', streaming: true, versions: [''], activeVersion: 0 };
  const messages = [...(chat.messages || []), assistantMsg];
  await updateChat(chatId, { messages });

  state.abortController = new AbortController();

  const apiMessages = buildApiMessages(chat.messages, assistantMsg);

  let full = '';

  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      signal: state.abortController.signal,
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin,
        'X-Title': 'NEXGPT'
      },
      body: JSON.stringify({
        model: state.activeModelId,
        messages: apiMessages,
        stream: true,
        temperature: state.settings.temperature,
        max_tokens: state.settings.maxTokens
      })
    });

    if (!res.ok) {
      let err = `HTTP ${res.status}`;
      try { const j = await res.json(); err = j?.error?.message || err; } catch (_) {}
      throw new Error(err);
    }

    const reader = res.body.getReader();
    const decoder = new TextDecoder('utf-8');
    let buf = '';

    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const line of lines) {
        const t = line.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const delta = j?.choices?.[0]?.delta?.content;
          if (delta) {
            full += delta;
            assistantMsg.content = full;
            assistantMsg.versions[0] = full;
            updateStreamingBubble(chatId, assistantMsg);
          }
        } catch (_) {}
      }
    }

    assistantMsg.streaming = false;
    assistantMsg.content = full || '(empty response)';
    assistantMsg.versions[0] = assistantMsg.content;
    const finalMessages = [...chat.messages, assistantMsg];
    await updateChat(chatId, { messages: finalMessages });

    if (state.settings.autoTTS && assistantMsg.content) speakText(assistantMsg.content);
  } catch (err) {
    if (err.name === 'AbortError') {
      assistantMsg.streaming = false;
      if (!assistantMsg.content) assistantMsg.content = '(stopped)';
      const finalMessages = [...chat.messages, assistantMsg];
      await updateChat(chatId, { messages: finalMessages });
    } else {
      const errMsg = { role: 'error', content: err.message || 'Failed to reach model.' };
      const finalMessages = [...chat.messages, errMsg];
      await updateChat(chatId, { messages: finalMessages });
    }
  } finally {
    state.streaming = false;
    state.abortController = null;
    updateSendButton();
  }
}

function buildApiMessages(history, currentAssistant) {
  const sys = { role: 'system', content: state.settings.systemPrompt + (state.webSearch ? ' The user has enabled web search. When answering, indicate you searched the web and provide the most current answer you can.' : '') };
  const out = [sys];
  for (const m of history) {
    if (m === currentAssistant) continue;
    if (m.role === 'user' || m.role === 'assistant') {
      const content = buildContentForModel(m);
      out.push({ role: m.role, content });
    }
  }
  return out;
}

function buildContentForModel(m) {
  if (!m.attachments || m.attachments.length === 0) return m.content || '';
  const parts = [];
  if (m.content) parts.push({ type: 'text', text: m.content });
  m.attachments.forEach((a) => {
    if (a.kind === 'image' && a.dataUrl) {
      parts.push({ type: 'image_url', image_url: { url: a.dataUrl } });
    } else if (a.textContent) {
      parts.push({ type: 'text', text: `[Attached file: ${a.name}]\n${a.textContent}` });
    }
  });
  return parts.length ? parts : (m.content || '');
}

function updateStreamingBubble(chatId, assistantMsg) {
  const rows = $('messages').querySelectorAll('.msg-row.ai');
  const last = rows[rows.length - 1];
  if (!last) return;
  const content = last.querySelector('.ai-content');
  if (content) content.innerHTML = renderMarkdown(assistantMsg.content);
  attachCodeCopyButtons();
  if (isNearBottom()) scrollToBottom();
}

async function stopStreaming() {
  if (state.abortController) state.abortController.abort();
}

function retryLast() {
  const chat = getActiveChat();
  if (!chat) return;
  // remove trailing error
  const msgs = [...chat.messages];
  while (msgs.length && msgs[msgs.length - 1].role === 'error') msgs.pop();
  updateChat(chat.id, { messages: msgs }).then(() => streamAssistant(chat.id));
}

async function regenerateMessage(chat, idx) {
  if (state.streaming) return;
  const msgs = [...chat.messages];
  const target = msgs[idx];
  if (!target || target.role !== 'assistant') return;

  // trim everything after this assistant message
  const head = msgs.slice(0, idx);
  await updateChat(chat.id, { messages: head });
  await streamAssistant(chat.id);

  // after streaming, append version to the new assistant message
  const refreshed = state.chats.find((c) => c.id === chat.id);
  const newIdx = refreshed.messages.length - 1;
  const newMsg = refreshed.messages[newIdx];
  if (newMsg && newMsg.role === 'assistant') {
    const versions = target.versions ? [...target.versions, newMsg.content] : [target.content, newMsg.content];
    newMsg.versions = versions;
    newMsg.activeVersion = versions.length - 1;
    await updateChat(chat.id, { messages: refreshed.messages });
  }
}

function switchVersion(chat, idx, dir) {
  const msgs = [...chat.messages];
  const m = msgs[idx];
  if (!m || !m.versions) return;
  const nv = clamp((m.activeVersion || 0) + dir, 0, m.versions.length - 1);
  if (nv === m.activeVersion) return;
  m.activeVersion = nv;
  m.content = m.versions[nv];
  updateChat(chat.id, { messages: msgs });
}

/* ============================================================
   AUTO-TITLE
   ============================================================ */
async function autoTitle(chatId) {
  const chat = state.chats.find((c) => c.id === chatId);
  if (!chat || !chat.messages || chat.messages.length < 2) return;
  if (chat.title && chat.title.length > 6 && chat.title !== 'New chat') return;
  try {
    const firstUser = chat.messages.find((m) => m.role === 'user');
    if (!firstUser) return;
    const firstAi = chat.messages.find((m) => m.role === 'assistant');
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin,
        'X-Title': 'NEXGPT'
      },
      body: JSON.stringify({
        model: 'meta-llama/llama-3.3-70b-instruct:free',
        messages: [
          { role: 'system', content: 'You generate short chat titles. Reply with 3-5 words, no quotes, no punctuation.' },
          { role: 'user', content: `User asked: ${firstUser.content.slice(0,200)}\nAI replied: ${(firstAi?.content || '').slice(0,200)}\n\nGive a title:` }
        ],
        temperature: 0.5,
        max_tokens: 20
      })
    });
    if (!res.ok) return;
    const j = await res.json();
    const t = j?.choices?.[0]?.message?.content?.trim().replace(/^["']|["']$/g, '').slice(0, 40);
    if (t) updateChat(chatId, { title: t });
  } catch (_) {}
}

/* ============================================================
   ATTACHMENTS
   ============================================================ */
async function processFile(file) {
  if (file.size > MAX_FILE_BYTES) {
    toast(`"${file.name}" is too large (max 10 MB).`, 'error');
    return null;
  }
  const ext = (file.name.split('.').pop() || '').toLowerCase();
  const isImage = file.type.startsWith('image/');
  const isAudio = file.type.startsWith('audio/');
  const isPdf = file.type === 'application/pdf' || ext === 'pdf';
  const isText = ['txt','md','json','csv','log'].includes(ext) || file.type.startsWith('text/');

  if (isImage) {
    const dataUrl = await readAsDataURL(file);
    return { kind: 'image', name: file.name, size: file.size, dataUrl };
  }
  if (isAudio) {
    return { kind: 'audio', name: file.name, size: file.size };
  }
  if (isPdf) {
    const text = await extractPdfText(file);
    return { kind: 'pdf', name: file.name, size: file.size, textContent: text };
  }
  if (isText) {
    const text = await file.text();
    return { kind: 'text', name: file.name, size: file.size, textContent: text.slice(0, 20000) };
  }
  toast(`Unsupported file type: ${file.name}`, 'error');
  return null;
}

function readAsDataURL(file) {
  return new Promise((resolve, reject) => {
    const r = new FileReader();
    r.onload = () => resolve(r.result);
    r.onerror = reject;
    r.readAsDataURL(file);
  });
}

async function extractPdfText(file) {
  try {
    if (!window.pdfjsLib) {
      await loadPdfJs();
    }
    const buf = await file.arrayBuffer();
    const pdf = await window.pdfjsLib.getDocument({ data: buf }).promise;
    let out = '';
    const maxPages = Math.min(pdf.numPages, 30);
    for (let i = 1; i <= maxPages; i++) {
      const page = await pdf.getPage(i);
      const content = await page.getTextContent();
      out += content.items.map((it) => it.str).join(' ') + '\n\n';
      if (out.length > 20000) break;
    }
    return out.slice(0, 20000);
  } catch (e) {
    console.warn('PDF extract failed', e);
    return '[PDF text could not be extracted]';
  }
}

function loadPdfJs() {
  return new Promise((resolve, reject) => {
    const s = document.createElement('script');
    s.src = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.min.js';
    s.onload = () => {
      window.pdfjsLib.GlobalWorkerOptions.workerSrc = 'https://cdnjs.cloudflare.com/ajax/libs/pdf.js/3.11.174/pdf.worker.min.js';
      resolve();
    };
    s.onerror = reject;
    document.head.appendChild(s);
  });
}

async function handleFiles(fileList) {
  const files = Array.from(fileList);
  for (const f of files) {
    if (state.attachments.length >= MAX_FILES) {
      toast(`Max ${MAX_FILES} files per message.`, 'error');
      break;
    }
    const item = await processFile(f);
    if (item) state.attachments.push(item);
  }
  renderAttachTray();
  updateSendButton();
}

function renderAttachTray() {
  const tray = $('attachTray');
  tray.innerHTML = '';
  if (state.attachments.length === 0) {
    tray.classList.add('hidden');
    return;
  }
  tray.classList.remove('hidden');
  state.attachments.forEach((a, i) => {
    const item = el('div', 'attach-item' + (a.kind === 'image' ? ' thumbnail' : ''));
    if (a.kind === 'image') {
      const img = el('img');
      img.src = a.dataUrl;
      item.appendChild(img);
    } else {
      const ic = el('i');
      ic.className = 'fa-solid ' + (a.kind === 'audio' ? 'fa-microphone-lines' : a.kind === 'pdf' ? 'fa-file-pdf' : 'fa-file-lines') + ' file-icon';
      item.appendChild(ic);
      const nm = el('div', 'attach-item-thumb-name', esc(a.name));
      item.appendChild(nm);
    }
    const rm = el('button', 'attach-item-remove', '<i class="fa-solid fa-xmark"></i>');
    rm.addEventListener('click', () => {
      state.attachments.splice(i, 1);
      renderAttachTray();
      updateSendButton();
    });
    item.appendChild(rm);
    tray.appendChild(item);
  });
}

/* ============================================================
   VOICE — STT + TTS + OVERLAY
   ============================================================ */
let recognition = null;
let voiceLoopActive = false;
let currentUtterance = null;

function initRecognition() {
  const SR = window.SpeechRecognition || window.webkitSpeechRecognition;
  if (!SR) return null;
  const r = new SR();
  r.lang = 'en-US';
  r.continuous = false;
  r.interimResults = true;
  return r;
}

function startDictation() {
  if (!recognition) recognition = initRecognition();
  if (!recognition) { toast('Speech recognition not supported in this browser.', 'error'); return; }
  const btn = $('voiceBtn');
  btn.classList.add('recording');
  let finalText = '';
  recognition.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    $('chatInput').value = (finalText + interim).trim();
    autoResizeTextarea();
    updateSendButton();
  };
  recognition.onerror = () => {
    btn.classList.remove('recording');
    toast('Voice input error.', 'error');
  };
  recognition.onend = () => {
    btn.classList.remove('recording');
  };
  recognition.start();
}

function stopDictation() {
  if (recognition) recognition.stop();
  $('voiceBtn').classList.remove('recording');
}

function speakText(text) {
  if (!('speechSynthesis' in window)) return;
  window.speechSynthesis.cancel();
  const u = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, 'code block omitted').slice(0, 4000));
  const voices = window.speechSynthesis.getVoices();
  const chosen = voices.find((v) => v.voiceURI === state.settings.voiceURI);
  if (chosen) u.voice = chosen;
  u.rate = 1;
  u.pitch = 1;
  currentUtterance = u;
  window.speechSynthesis.speak(u);
}

function stopSpeaking() {
  if ('speechSynthesis' in window) window.speechSynthesis.cancel();
}

function populateVoiceList() {
  if (!('speechSynthesis' in window)) return;
  const sel = $('settingsVoice');
  const voices = window.speechSynthesis.getVoices();
  sel.innerHTML = '<option value="">Default</option>';
  voices.forEach((v) => {
    const o = document.createElement('option');
    o.value = v.voiceURI;
    o.textContent = `${v.name} (${v.lang})`;
    if (v.voiceURI === state.settings.voiceURI) o.selected = true;
    sel.appendChild(o);
  });
}

/* Voice chat overlay — full loop */
async function startVoiceChat() {
  if (state.isGuest) {
    toast('Voice chat requires an account.', 'error');
    return;
  }
  if (!recognition) recognition = initRecognition();
  if (!recognition) { toast('Speech recognition not supported.', 'error'); return; }
  $('voiceOverlay').classList.remove('hidden');
  $('voiceTranscript').innerHTML = '';
  voiceLoopActive = true;
  voiceListenOnce();
}

function voiceListenOnce() {
  if (!voiceLoopActive) return;
  setVoiceState('listening');
  setVoiceLabel('Listening…');
  const r = recognition;
  let finalText = '';
  r.onresult = (e) => {
    let interim = '';
    for (let i = e.resultIndex; i < e.results.length; i++) {
      const t = e.results[i][0].transcript;
      if (e.results[i].isFinal) finalText += t;
      else interim += t;
    }
    setVoiceLabel((finalText + interim).slice(0, 80) || 'Listening…');
  };
  r.onerror = () => { if (voiceLoopActive) setVoiceLabel('Mic error. Tap to retry.'); };
  r.onend = async () => {
    if (!voiceLoopActive) return;
    const text = finalText.trim();
    if (!text) { setVoiceState('idle'); return; }
    appendVoiceTurn('user', text);
    await voiceProcess(text);
  };
  try { r.start(); } catch (_) {}
}

async function voiceProcess(text) {
  setVoiceState('thinking');
  setVoiceLabel('Thinking…');
  const chat = getActiveChat();
  if (!chat) return;
  const userMsg = { role: 'user', content: text };
  const assistantMsg = { role: 'assistant', content: '', streaming: true };
  const messages = [...(chat.messages || []), userMsg, assistantMsg];
  await updateChat(chat.id, { messages });

  const apiMessages = buildApiMessages([...(chat.messages || []), userMsg], assistantMsg);
  let full = '';
  try {
    const res = await fetch(API_URL, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${OPENROUTER_KEY}`,
        'Content-Type': 'application/json',
        'HTTP-Referer': window.location.origin,
        'X-Title': 'NEXGPT'
      },
      body: JSON.stringify({
        model: state.activeModelId,
        messages: apiMessages,
        stream: true,
        temperature: state.settings.temperature,
        max_tokens: state.settings.maxTokens
      })
    });
    const reader = res.body.getReader();
    const dec = new TextDecoder('utf-8');
    let buf = '';
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += dec.decode(value, { stream: true });
      const lines = buf.split('\n');
      buf = lines.pop() || '';
      for (const l of lines) {
        const t = l.trim();
        if (!t.startsWith('data:')) continue;
        const data = t.slice(5).trim();
        if (data === '[DONE]') continue;
        try {
          const j = JSON.parse(data);
          const d = j?.choices?.[0]?.delta?.content;
          if (d) full += d;
        } catch (_) {}
      }
    }
    assistantMsg.content = full;
    assistantMsg.streaming = false;
    const finalMsgs = [...(chat.messages || []), userMsg, assistantMsg];
    await updateChat(chat.id, { messages: finalMsgs });
    appendVoiceTurn('ai', full);
    setVoiceState('speaking');
    setVoiceLabel('Speaking…');
    await speakAndWait(full);
    if (voiceLoopActive) voiceListenOnce();
  } catch (err) {
    toast('Voice chat error.', 'error');
    voiceLoopActive = false;
    closeVoiceChat();
  }
}

function speakAndWait(text) {
  return new Promise((resolve) => {
    if (!('speechSynthesis' in window)) return resolve();
    const u = new SpeechSynthesisUtterance(text.replace(/```[\s\S]*?```/g, 'code omitted').slice(0, 4000));
    const voices = window.speechSynthesis.getVoices();
    const chosen = voices.find((v) => v.voiceURI === state.settings.voiceURI);
    if (chosen) u.voice = chosen;
    u.onend = resolve;
    u.onerror = resolve;
    window.speechSynthesis.cancel();
    window.speechSynthesis.speak(u);
  });
}

function setVoiceState(s) {
  const orb = $('voiceOrb');
  orb.classList.remove('listening', 'speaking', 'thinking', 'idle');
  orb.classList.add(s);
}
function setVoiceLabel(t) { $('voiceLabel').textContent = t; }

function appendVoiceTurn(who, text) {
  const t = el('div', 't-turn ' + (who === 'user' ? 't-user' : 't-ai'));
  t.innerHTML = `<strong>${who === 'user' ? 'You' : 'NEXGPT'}:</strong> ${esc(text)}`;
  const box = $('voiceTranscript');
  box.appendChild(t);
  box.scrollTop = box.scrollHeight;
}

function closeVoiceChat() {
  voiceLoopActive = false;
  stopSpeaking();
  if (recognition) try { recognition.stop(); } catch (_) {}
  $('voiceOverlay').classList.add('hidden');
}

/* ============================================================
   SETTINGS MODAL BINDINGS
   ============================================================ */
function openSettings() {
  $('settingsSystemPrompt').value = state.settings.systemPrompt;
  $('settingsTemp').value = state.settings.temperature;
  $('settingsTempVal').textContent = state.settings.temperature.toFixed(1);
  $('settingsMaxTokens').value = state.settings.maxTokens;
  $('settingsMaxTokensVal').textContent = state.settings.maxTokens;
  $('settingsAutoTTS').checked = !!state.settings.autoTTS;
  $$('#presetRow .chip').forEach((c) => c.classList.toggle('active', c.dataset.preset === state.settings.preset));
  applyAccent(state.settings.accent);
  populateVoiceList();
  $('settingsModal').classList.remove('hidden');
}

/* ============================================================
   EXPORT / SHARE / COPY ALL
   ============================================================ */
function chatToMarkdown(chat) {
  const lines = [`# ${chat.title || 'Chat'}`, ''];
  (chat.messages || []).forEach((m) => {
    if (m.role === 'user') lines.push(`**You:** ${m.content}`, '');
    else if (m.role === 'assistant') lines.push(`**NEXGPT:** ${m.content}`, '');
    else if (m.role === 'error') lines.push(`**Error:** ${m.content}`, '');
  });
  return lines.join('\n');
}

function exportAllChats() {
  const data = JSON.stringify(state.chats, null, 2);
  const blob = new Blob([data], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `nexgpt-chats-${new Date().toISOString().slice(0,10)}.json`;
  a.click();
  URL.revokeObjectURL(url);
  toast('Chats exported.', 'success');
}

function copyAll() {
  const chat = getActiveChat();
  if (!chat) return;
  navigator.clipboard.writeText(chatToMarkdown(chat));
  toast('Conversation copied.', 'success');
}

function shareChat() {
  const chat = getActiveChat();
  if (!chat) return;
  const md = chatToMarkdown(chat);
  const encoded = btoa(unescape(encodeURIComponent(md))).slice(0, 1800);
  const url = `${location.origin}/?shared=${encoded}`;
  navigator.clipboard.writeText(url);
  toast('Share link copied.', 'success');
}

/* ============================================================
   SIDEBAR MOBILE
   ============================================================ */
function openSidebarMobile() {
  $('sidebar').classList.add('open');
  $('backdrop').classList.add('show');
}
function closeSidebarMobile() {
  $('sidebar').classList.remove('open');
  $('backdrop').classList.remove('show');
}

/* ============================================================
   KEYBOARD SHORTCUTS
   ============================================================ */
document.addEventListener('keydown', (e) => {
  const inInput = ['INPUT', 'TEXTAREA'].includes(document.activeElement?.tagName);
  if (e.key === 'Escape') {
    if (state.streaming) { stopStreaming(); return; }
    if (!$('voiceOverlay').classList.contains('hidden')) { closeVoiceChat(); return; }
    $$('.modal-overlay').forEach((m) => m.classList.add('hidden'));
    $('modelMenu').classList.add('hidden');
    $('userPopover').classList.add('hidden');
    return;
  }
  if (e.ctrlKey || e.metaKey) {
    if (e.key === 'k') { e.preventDefault(); $('newChatBtn').click(); }
    if (e.key === 'b') { e.preventDefault(); $('sidebar').classList.toggle('open'); }
    if (e.key === 'i') { e.preventDefault(); $('chatSearchInput').focus(); }
  }
});

/* ============================================================
   EVENT BINDINGS
   ============================================================ */
function bindEvents() {
  // auth tabs
  $('tabSignin').addEventListener('click', () => setAuthTab('signin'));
  $('tabSignup').addEventListener('click', () => setAuthTab('signup'));
  $('signinForm').addEventListener('submit', doSignin);
  $('signupForm').addEventListener('submit', doSignup);
  $('googleSigninBtn').addEventListener('click', doGoogle);
  $('guestBtn').addEventListener('click', doGuest);
  $('forgotPasswordBtn').addEventListener('click', doForgot);

  // password visibility
  $$('.field-eye').forEach((btn) => {
    btn.addEventListener('click', () => {
      const target = $(btn.dataset.eye);
      if (!target) return;
      target.type = target.type === 'password' ? 'text' : 'password';
      const icon = btn.querySelector('i');
      icon.className = target.type === 'password' ? 'fa-regular fa-eye' : 'fa-regular fa-eye-slash';
    });
  });

  // new chat
  $('newChatBtn').addEventListener('click', () => {
    createChat().then(() => {
      $('chatInput').focus();
      closeSidebarMobile();
    });
  });

  // search
  $('chatSearchInput').addEventListener('input', (e) => {
    state.searchQuery = e.target.value;
    $('chatSearchClear').classList.toggle('hidden', !state.searchQuery);
    renderChatList();
  });
  $('chatSearchClear').addEventListener('click', () => {
    state.searchQuery = '';
    $('chatSearchInput').value = '';
    $('chatSearchClear').classList.add('hidden');
    renderChatList();
  });

  // guest banner signin
  $('guestBannerSignin').addEventListener('click', doSignout);
  $('guestUpgradeBtn').addEventListener('click', doSignout);

  // user card
  $('userCardBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const pop = $('userPopover');
    const show = pop.classList.contains('hidden');
    pop.classList.toggle('hidden');
    $('userCardBtn').setAttribute('aria-expanded', show);
  });
  document.addEventListener('click', (e) => {
    if (!$('userPopover').contains(e.target) && e.target !== $('userCardBtn')) {
      $('userPopover').classList.add('hidden');
    }
    if (!$('modelMenu').contains(e.target) && e.target !== $('modelSelectorBtn')) {
      $('modelMenu').classList.add('hidden');
    }
    if (!$('attachMenu').contains(e.target) && e.target !== $('attachBtn')) {
      $('attachMenu').classList.add('hidden');
    }
  });

  $('openSettingsBtn').addEventListener('click', () => { $('userPopover').classList.add('hidden'); openSettings(); });
  $('openExportBtn').addEventListener('click', () => { $('userPopover').classList.add('hidden'); exportAllChats(); });
  $('signOutBtn').addEventListener('click', () => { $('userPopover').classList.add('hidden'); doSignout(); });
  $('upgradeGuestBtn').addEventListener('click', () => { $('userPopover').classList.add('hidden'); doSignout(); });

  // mobile menu
  $('mobileMenuBtn').addEventListener('click', openSidebarMobile);
  $('backdrop').addEventListener('click', closeSidebarMobile);

  // model selector
  $('modelSelectorBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    const m = $('modelMenu');
    m.classList.toggle('hidden');
    $('modelSelectorBtn').setAttribute('aria-expanded', !m.classList.contains('hidden'));
  });

  // header buttons
  $('copyAllBtn').addEventListener('click', copyAll);
  $('shareBtn').addEventListener('click', shareChat);

  // input
  const input = $('chatInput');
  input.addEventListener('input', () => {
    if (input.value === '') resetTextarea();
    else autoResizeTextarea();
    updateSendButton();
  });
  input.addEventListener('focus', () => {
    setTimeout(() => { if (isNearBottom()) scrollToBottom(); }, 250);
  });
  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && (e.ctrlKey || e.metaKey)) {
      e.preventDefault();
      if (!$('sendBtn').disabled) handleSend();
    }
  });
  // paste image
  input.addEventListener('paste', (e) => {
    const items = Array.from(e.clipboardData?.items || []);
    const files = items.filter((it) => it.kind === 'file').map((it) => it.getAsFile()).filter(Boolean);
    if (files.length) handleFiles(files);
  });

  $('sendBtn').addEventListener('click', handleSend);
  $('stopBtn').addEventListener('click', stopStreaming);

  // attach menu
  $('attachBtn').addEventListener('click', (e) => {
    e.stopPropagation();
    $('attachMenu').classList.toggle('hidden');
  });
  $$('#attachMenu [data-attach]').forEach((b) => {
    b.addEventListener('click', () => {
      const kind = b.dataset.attach;
      $('attachMenu').classList.add('hidden');
      if (kind === 'images') $('fileInputImages').click();
      else if (kind === 'camera') $('fileInputCamera').click();
      else if (kind === 'docs') $('fileInputDocs').click();
      else if (kind === 'audio') $('fileInputAudio').click();
    });
  });
  ['fileInputImages','fileInputCamera','fileInputDocs','fileInputAudio'].forEach((id) => {
    $(id).addEventListener('change', (e) => {
      handleFiles(e.target.files);
      e.target.value = '';
    });
  });

  // web toggle
  $('webToggleBtn').addEventListener('click', () => {
    state.webSearch = !state.webSearch;
    $('webToggleBtn').classList.toggle('active', state.webSearch);
    $('webPill').classList.toggle('hidden', !state.webSearch);
  });

  // voice
  $('voiceBtn').addEventListener('click', () => {
    const btn = $('voiceBtn');
    if (btn.classList.contains('recording')) stopDictation();
    else startDictation();
  });
  // long-press voice button for full voice chat
  let vPressTimer = null;
  $('voiceBtn').addEventListener('pointerdown', () => {
    vPressTimer = setTimeout(() => {
      vPressTimer = null;
      startVoiceChat();
    }, 600);
  });
  $('voiceBtn').addEventListener('pointerup', () => { if (vPressTimer) { clearTimeout(vPressTimer); vPressTimer = null; } });
  $('voiceBtn').addEventListener('pointerleave', () => { if (vPressTimer) { clearTimeout(vPressTimer); vPressTimer = null; } });

  $('voiceCloseBtn').addEventListener('click', closeVoiceChat);
  $('voiceEndBtn').addEventListener('click', closeVoiceChat);
  $('voiceMuteBtn').addEventListener('click', () => {
    const b = $('voiceMuteBtn');
    b.classList.toggle('muted');
    if (b.classList.contains('muted')) { stopSpeaking(); if (recognition) try { recognition.stop(); } catch (_) {} }
    else if (voiceLoopActive) voiceListenOnce();
  });

  // scroll bottom
  $('scrollBottomBtn').addEventListener('click', scrollToBottom);
  $('messagesWrap').addEventListener('scroll', () => {
    $('scrollBottomBtn').classList.toggle('hidden', isNearBottom());
  });

  // modals close
  $$('[data-close]').forEach((b) => b.addEventListener('click', () => {
    $(b.dataset.close).classList.add('hidden');
  }));
  $$('.modal-overlay').forEach((m) => m.addEventListener('click', (e) => {
    if (e.target === m) m.classList.add('hidden');
  }));

  // settings interactions
  $('settingsTemp').addEventListener('input', (e) => {
    state.settings.temperature = parseFloat(e.target.value);
    $('settingsTempVal').textContent = state.settings.temperature.toFixed(1);
    saveSettings();
  });
  $('settingsMaxTokens').addEventListener('input', (e) => {
    state.settings.maxTokens = parseInt(e.target.value, 10);
    $('settingsMaxTokensVal').textContent = state.settings.maxTokens;
    saveSettings();
  });
  $('settingsAutoTTS').addEventListener('change', (e) => {
    state.settings.autoTTS = e.target.checked;
    saveSettings();
  });
  $('settingsVoice').addEventListener('change', (e) => {
    state.settings.voiceURI = e.target.value;
    saveSettings();
  });
  $('settingsSystemPrompt').addEventListener('input', (e) => {
    state.settings.systemPrompt = e.target.value;
    state.settings.preset = '';
    $$('#presetRow .chip').forEach((c) => c.classList.remove('active'));
    saveSettings();
  });
  $$('#presetRow .chip').forEach((c) => {
    c.addEventListener('click', () => {
      const p = c.dataset.preset;
      state.settings.preset = p;
      state.settings.systemPrompt = SYSTEM_PRESETS[p] || DEFAULT_SYSTEM_PROMPT;
      $('settingsSystemPrompt').value = state.settings.systemPrompt;
      $$('#presetRow .chip').forEach((x) => x.classList.toggle('active', x === c));
      saveSettings();
    });
  });
  $$('#accentPicker .accent-dot').forEach((d) => {
    d.addEventListener('click', () => {
      state.settings.accent = d.dataset.accent;
      applyAccent(d.dataset.accent);
      saveSettings();
    });
  });
  $('clearAllChatsBtn').addEventListener('click', () => {
    if (!confirm('Delete ALL chats? This cannot be undone.')) return;
    clearAllChats();
  });
}

/* ============================================================
   PWA MANIFEST INJECTION
   ============================================================ */
function injectManifest() {
  const manifest = {
    name: 'NEXGPT',
    short_name: 'NEXGPT',
    start_url: '/',
    display: 'standalone',
    background_color: '#ffffff',
    theme_color: '#1a1a1e',
    icons: [
      {
        src: 'data:image/svg+xml;base64,' + btoa(`<svg xmlns="http://www.w3.org/2000/svg" width="512" height="512" viewBox="0 0 512 512"><rect width="512" height="512" rx="96" fill="#1a1a1e"/><path d="M280 96l-140 180h88l-28 140 140-180h-88z" fill="#fff"/></svg>`),
        sizes: '512x512',
        type: 'image/svg+xml',
        purpose: 'any maskable'
      }
    ]
  };
  const blob = new Blob([JSON.stringify(manifest)], { type: 'application/manifest+json' });
  const link = document.querySelector('link[rel="manifest"]');
  if (link) link.href = URL.createObjectURL(blob);
}

/* ============================================================
   BOOT
   ============================================================ */
function boot() {
  loadSettings();
  bindEvents();
  injectManifest();
  renderModelMenu();
  updateModelLabel();

  if ('speechSynthesis' in window) {
    window.speechSynthesis.onvoiceschanged = populateVoiceList;
    setTimeout(populateVoiceList, 200);
  }

  onAuthStateChanged(auth, onUserChanged);
}

boot();
