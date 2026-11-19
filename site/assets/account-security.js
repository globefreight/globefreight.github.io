let pendingMfa = null;
let recoverySession = null;
const recoveryKey = 'globefreight.recovery.' + siteRoot.pathname;

function showAccountForm(mode) {
  const forms = { signin:'signin-form', recover:'recover-form', reset:'reset-form', verify:'verify-signin-form' };
  for (const [name,id] of Object.entries(forms)) $(id).hidden = name !== mode;
  $('signin-title').textContent = {
    signin:'GlobeFreight Team Sign-In', recover:'Reset your password',
    reset:'Choose a new password', verify:'Verify your sign-in'
  }[mode];
  $('signin-intro').textContent = {
    signin:'Use your staff or administrator email to open your workspace.',
    recover:'Enter your team email to request a reset link.',
    reset:'Choose a new password with at least 12 characters.',
    verify:'Enter the six-digit code from your authenticator app.'
  }[mode];
  message($('signin-message'));
}

function resetAccountSecurity() {
  pendingMfa = null;
  recoverySession = null;
  $('verify-signin-form').reset();
  $('reset-form').reset();
  $('mfa-settings').open = false;
  $('mfa-settings-body').replaceChildren();
  message($('mfa-settings-message'));
  showAccountForm('signin');
}

$('forgot-password').onclick = () => {
  $('recover-email').value = $('signin-email').value;
  setSigninPasswordVisible(false);
  $('signin-password').value = '';
  showAccountForm('recover');
  $('recover-email').focus();
};

for (const back of document.querySelectorAll('.auth-back')) {
  back.onclick = () => {
    const token = pendingMfa?.auth.access_token || recoverySession?.access_token;
    resetAccountSecurity();
    $('signin-email').focus();
    if (token) request('/auth/v1/logout?scope=local', { method:'POST', token }).catch(() => {});
  };
}

function base64Url(bytes) {
  return btoa(String.fromCharCode(...bytes)).replaceAll('+','-').replaceAll('/','_').replaceAll('=','');
}

bind($('recover-form'), async values => {
  if (!crypto.subtle) throw new Error('Open the secure GlobeFreight website to reset your password.');
  const verifier = base64Url(crypto.getRandomValues(new Uint8Array(48)));
  const challenge = base64Url(new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(verifier))));
  const redirect = new URL(cleanPages ? 'portal/' : '#portal', siteRoot);
  localStorage.setItem(recoveryKey,JSON.stringify({verifier,expiresAt:Date.now()+3600000}));
  try {
    await request('/auth/v1/recover?redirect_to='+encodeURIComponent(redirect.href), {
      method:'POST',body:{email:values.get('email').trim(),code_challenge:challenge,code_challenge_method:'s256'}
    });
  } catch {
    // Keep the response identical for addresses that do not belong to a team account.
  }
  message($('signin-message'),'If the account is eligible, a reset link will be sent. Open it in this same browser.');
},$('signin-message'));

async function resumePasswordRecovery() {
  const url = new URL(location.href);
  const authCode = url.searchParams.get('code');
  if (!authCode || $('portal-page').hidden) return;
  url.searchParams.delete('code');
  history.replaceState(null,'',url.href);
  try {
    const data=JSON.parse(localStorage.getItem(recoveryKey)||'null');
    localStorage.removeItem(recoveryKey);
    if (!data?.verifier || data.expiresAt<=Date.now()) throw new Error('Request a new reset link from this browser.');
    const auth=await request('/auth/v1/token?grant_type=pkce',{
      method:'POST',body:{auth_code:authCode,code_verifier:data.verifier}
    });
    if (!auth?.access_token) throw new Error('This reset link is unavailable.');
    recoverySession=auth;
    showAccountForm('reset');
    $('new-password').focus();
  } catch {
    message($('signin-message'),'This reset link is expired or belongs to another browser. Request a new link.',true);
  }
}

bind($('reset-form'), async values => {
  if (!recoverySession?.access_token) throw new Error('Request a new password reset link.');
  const password = values.get('password');
  if (password !== values.get('confirmation')) throw new Error('The passwords must match.');
  if (password.length < 12 || new TextEncoder().encode(password).length > 72) {
    throw new Error('Use at least 12 characters and at most 72 UTF-8 bytes.');
  }
  const active = recoverySession;
  await request('/auth/v1/user',{method:'PUT',token:active.access_token,body:{password}});
  if (recoverySession !== active) return;
  await request('/auth/v1/logout?scope=local',{method:'POST',token:active.access_token}).catch(()=>{});
  resetAccountSecurity();
  message($('signin-message'),'Password changed. Sign in with your new password.');
},$('signin-message'));

function authUser(token) {
  return request('/auth/v1/user',{token});
}

async function prepareSigninVerification(auth) {
  const user = await authUser(auth.access_token);
  const factors = (user?.factors || []).filter(factor=>factor.factor_type==='totp' && factor.status==='verified');
  if (!factors.length) throw new Error('This account needs an authenticator factor. Contact your GlobeFreight administrator.');
  const factor = $('signin-factor');
  factor.replaceChildren(...factors.map((item,index)=>new Option(item.friendly_name || 'Authenticator '+(index+1),item.id)));
  $('signin-factor-field').hidden = factors.length===1;
  pendingMfa={auth:{...auth,user}, factors};
  $('signin-form').reset();
  showAccountForm('verify');
  $('signin-otp').focus();
}

async function verifyAuthenticator(factor,code,token) {
  if (!/^\d{6}$/.test(code)) throw new Error('Enter a six-digit authenticator code.');
  const path='/auth/v1/factors/'+encodeURIComponent(factor);
  const challenge=await request(path+'/challenge',{method:'POST',token,body:{}});
  return request(path+'/verify',{method:'POST',token,body:{challenge_id:challenge.id,code}});
}

bind($('verify-signin-form'), async values => {
  const pending = pendingMfa;
  if (!pending) throw new Error('Sign in again before entering your code.');
  const factor = $('signin-factor').value;
  if (!pending.factors.some(item=>item.id===factor)) throw new Error('Choose your authenticator.');
  const verified=await verifyAuthenticator(factor,values.get('code').trim(),pending.auth.access_token);
  if (pendingMfa!==pending) return;
  if (!verified?.access_token) throw new Error('Could not verify your authenticator code.');
  const auth={...pending.auth,...verified};
  const rights=await request('/rest/v1/rpc/pf_rights',{method:'POST',body:{},token:auth.access_token});
  if (pendingMfa!==pending) return;
  if (rights?.mfa_required) throw new Error('Could not complete two-factor sign-in.');
  pendingMfa=null;
  $('verify-signin-form').reset();
  showAccountForm('signin');
  await enterTeamWorkspace(auth,rights);
},$('signin-message'));

async function showMfaSettings() {
  const active = session;
  if (!active || !isAdmin) return;
  const user=await authUser(active.access_token);
  const panel=$('mfa-settings');
  if (session!==active || !panel.open) return;
  const body=$('mfa-settings-body');
  const feedback=$('mfa-settings-message');
  const factors=(user.factors||[]).filter(item=>item.factor_type==='totp' && item.status==='verified');
  body.replaceChildren(el('p',factors.length ? 'Two-factor authentication is enabled for this account.' :
    'Use an authenticator app to enable two-factor authentication for this account.','muted'));
  for (const factor of factors) {
    const entry=el('div',undefined,'record');
    entry.append(el('strong',factor.friendly_name||'Authenticator'),button('Remove authenticator',async()=>{
      if (!window.confirm('Remove this authenticator from your account?')) return;
      await request('/auth/v1/factors/'+encodeURIComponent(factor.id),{method:'DELETE',token:active.access_token});
      await showMfaSettings();
      message(feedback,'Authenticator removed.');
    },'secondary danger'));
    body.append(entry);
  }
  body.append(button('Set up authenticator',async()=>{
    if (session!==active || !panel.open) return;
    const label='GlobeFreight '+new Intl.DateTimeFormat('en',{dateStyle:'medium',timeStyle:'short'}).format(Date.now());
    const setup=await request('/auth/v1/factors',{
      method:'POST',token:active.access_token,body:{factor_type:'totp',issuer:'GlobeFreight Express',friendly_name:label}
    });
    if (session!==active || !panel.open) return;
    if (!setup?.id || !setup.totp?.uri) throw new Error('Could not start authenticator setup.');
    const qr=qrcode(0,'M');
    qr.addData(setup.totp.uri);
    qr.make();
    const image=el('img',undefined,'mfa-qr');
    image.src=qr.createDataURL(4,16);
    image.alt='Scan this code in your authenticator app';
    body.replaceChildren(el('p','Scan this code in your authenticator app, then enter the six-digit code.','muted'),image);
    if (setup.totp.secret) body.append(el('p','Manual setup key: '+setup.totp.secret,'mfa-secret'));
    const code=field('Authenticator code','code',{required:true,max:6});
    code.querySelector('input').inputMode='numeric';
    code.querySelector('input').pattern='[0-9]{6}';
    body.append(makeActionForm(feedback,async values=>{
      const verified=await verifyAuthenticator(setup.id,values.get('code').trim(),active.access_token);
      if (session!==active) return;
      if (!verified?.access_token) throw new Error('Could not enable the authenticator.');
      session={...active,...verified,expiresAt:Date.now()+(verified.expires_in-10)*1000};
      await showMfaSettings();
      message(feedback,'Two-factor authentication enabled.');
    },'Verify and enable',code));
    body.append(button('Cancel setup',async()=>{
      await request('/auth/v1/factors/'+encodeURIComponent(setup.id),{method:'DELETE',token:active.access_token});
      await showMfaSettings();
    }));
  }));
}

$('mfa-settings').addEventListener('toggle',()=>{
  if ($('mfa-settings').open) showMfaSettings().catch(error=>message($('mfa-settings-message'),error.message,true));
  else $('mfa-settings-body').replaceChildren();
});
resumePasswordRecovery();
