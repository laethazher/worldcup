import { post } from '../api.js';
import { themeToggle } from '../theme.js';

document.body.append(themeToggle('theme-fab'));

const form = document.getElementById('login-form') as HTMLFormElement;
const user = document.getElementById('u') as HTMLInputElement;
const pass = document.getElementById('p') as HTMLInputElement;
const btn = document.getElementById('go') as HTMLButtonElement;

async function submit(e: Event): Promise<void> {
  e.preventDefault();
  if (!user.value.trim() || !pass.value) return;
  btn.disabled = true;
  btn.textContent = 'جارٍ الدخول…';
  try {
    const r = await post<{ first_login: boolean; user: { name: string } }>(
      '/api/login', { username: user.value.trim(), password: pass.value });
    if (r.first_login) {
      try { sessionStorage.setItem('ahc-welcome', r.user.name); } catch { /* noop */ }
    }
    location.href = '/index.html';
  } catch {
    btn.disabled = false;
    btn.textContent = 'دخول';
    pass.value = '';
    pass.focus();
  }
}

form.addEventListener('submit', submit);
