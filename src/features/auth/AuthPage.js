import { esc } from '../../lib/html.js';
import { themeButton, wireThemeButton } from '../../lib/theme.js';
import { resetPassword, signInWithGoogle, signInWithMagicLink, signInWithPassword, signUp, updatePassword } from '../../services/supabaseClient.js';

export function renderAuth(t, mode = 'signin') {
  const titles = { signin: t.signInTitle, signup: t.signUpTitle, magic: t.magicLinkTitle, reset: t.resetTitle, 'reset-password': t.newPasswordTitle };
  const showPassword = mode === 'signin' || mode === 'signup' || mode === 'reset-password';
  const showEmail = mode !== 'reset-password';
  return `
    <div class="auth-screen">
      <form class="auth-card" id="auth-form" data-mode="${esc(mode)}">
        <div class="brand auth-brand"><span class="brand-mark">A</span><span>autexa</span></div>
        <h1>${esc(titles[mode])}</h1>
        <p class="muted-text">${esc(t.authSubtitle)}</p>
        ${mode === 'signup' ? `<label class="form-field"><span>${esc(t.fullName)}</span><input name="fullName" required autocomplete="name" /></label>` : ''}
        ${showEmail ? `<label class="form-field"><span>${esc(t.email)}</span><input name="email" type="email" required autocomplete="email" /></label>` : ''}
        ${showPassword ? `<label class="form-field"><span>${esc(t.password)}</span><input name="password" type="password" minlength="8" required autocomplete="${mode === 'signin' ? 'current-password' : 'new-password'}" /></label>` : ''}
        <p class="form-error" hidden></p>
        <p class="form-success" hidden></p>
        <button class="create wide-btn" type="submit">${esc({ signin: t.signIn, signup: t.signUp, magic: t.sendMagicLink, reset: t.sendResetLink, 'reset-password': t.save }[mode])}</button>
        ${mode === 'signin' || mode === 'signup' ? `<div class="auth-divider"><span>${esc(t.or)}</span></div>
        <button class="ghost-btn wide-btn" type="button" id="google-signin">${esc(t.continueWithGoogle)}</button>
        <button class="ghost-btn wide-btn" type="button" data-mode="magic">${esc(t.useMagicLink)}</button>` : ''}
        <div class="auth-links">
          ${mode !== 'signin' ? `<button type="button" class="link" data-mode="signin">${esc(t.haveAccount)}</button>` : `<button type="button" class="link" data-mode="signup">${esc(t.noAccount)}</button><button type="button" class="link" data-mode="reset">${esc(t.forgotPassword)}</button>`}
        </div>
      </form>
      <div class="auth-language">${themeButton(t)}<button class="language" id="language-toggle" type="button">${esc(t.switchLanguage)}</button></div>
    </div>`;
}

export function mountAuth(root, t, { onSignedIn, onModeChange, onLocale }) {
  const form = root.querySelector('#auth-form');
  const mode = form.dataset.mode;
  const errorBox = form.querySelector('.form-error');
  const successBox = form.querySelector('.form-success');
  root.querySelectorAll('button[data-mode]').forEach((button) => button.addEventListener('click', () => onModeChange(button.dataset.mode)));
  root.querySelector('#google-signin')?.addEventListener('click', signInWithGoogle);
  root.querySelector('#language-toggle')?.addEventListener('click', onLocale);
  wireThemeButton(root.querySelector('#theme-toggle'), t);
  form.addEventListener('submit', async (event) => {
    event.preventDefault();
    const data = Object.fromEntries(new FormData(form));
    const submit = form.querySelector('[type="submit"]');
    errorBox.hidden = true;
    successBox.hidden = true;
    submit.disabled = true;
    try {
      if (mode === 'signin') { await signInWithPassword(data.email, data.password); onSignedIn(); return; }
      if (mode === 'signup') {
        const result = await signUp(data.email, data.password, data.fullName);
        if (result?.access_token) { onSignedIn(); return; }
        successBox.textContent = t.checkEmailConfirm;
      }
      if (mode === 'magic') { await signInWithMagicLink(data.email); successBox.textContent = t.checkEmailLink; }
      if (mode === 'reset') { await resetPassword(data.email); successBox.textContent = t.checkEmailReset; }
      if (mode === 'reset-password') { await updatePassword(data.password); onSignedIn(); return; }
      successBox.hidden = false;
    } catch (error) {
      errorBox.textContent = error.message;
      errorBox.hidden = false;
    } finally {
      submit.disabled = false;
    }
  });
}
