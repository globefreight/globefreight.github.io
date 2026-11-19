(() => {
  const toggle = document.getElementById('menu-toggle');
  const navigation = document.getElementById('main-navigation');
  const label = document.getElementById('menu-label');
  const header = document.getElementById('page-top');
  const mobile = window.matchMedia('(max-width: 1015px)');

  const motion = document.getElementById('header-motion-toggle');
  const announcement = motion.closest('.header-message');
  motion.hidden = false;
  announcement.dataset.motion = 'playing';
  motion.addEventListener('click', () => {
    const paused = announcement.dataset.motion === 'playing';
    announcement.dataset.motion = paused ? 'paused' : 'playing';
    motion.textContent = paused ? 'Resume' : 'Pause';
    motion.setAttribute('aria-label', paused ? 'Resume header message' : 'Pause header message');
  });

  function setMenu(open, returnFocus = false) {
    toggle.setAttribute('aria-expanded', String(open));
    label.textContent = open ? 'Close' : 'Menu';
    if (returnFocus) toggle.focus();
  }

  toggle.hidden = false;
  header.classList.add('nav-ready');
  toggle.addEventListener('click', () => setMenu(toggle.getAttribute('aria-expanded') !== 'true'));
  navigation.addEventListener('click', event => {
    if (event.target.closest('a')) setMenu(false);
  });
  document.addEventListener('click', event => {
    if (!header.contains(event.target)) setMenu(false);
  });
  document.addEventListener('keydown', event => {
    if (event.key === 'Escape' && mobile.matches && toggle.getAttribute('aria-expanded') === 'true') {
      setMenu(false, true);
    }
  });
  mobile.addEventListener('change', event => {
    if (!event.matches) setMenu(false);
  });
  window.addEventListener('hashchange', () => setMenu(false));
})();
