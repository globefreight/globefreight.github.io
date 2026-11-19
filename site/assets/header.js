(() => {
  const toggle = document.getElementById('menu-toggle');
  const navigation = document.getElementById('main-navigation');
  const label = document.getElementById('menu-label');
  const header = document.getElementById('page-top');
  const mobile = window.matchMedia('(max-width: 1015px)');

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
