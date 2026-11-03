(() => {
  const completed = new WeakSet();
  const edited = new WeakSet();
  let defaults = null;
  let loading;
  let applying = false;
  const isLogin = () => location.hash.split("?", 1)[0] === "#/auth/login";
  const setValue = Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set;

  function fill() {
    if (!isLogin() || !defaults) return;
    for (const form of document.querySelectorAll("form")) {
      if (completed.has(form)) continue;
      const email = form.querySelector('input[name="email"]');
      const password = form.querySelector('input[name="password"]');
      if (!email || !password) continue;
      completed.add(form);
      if (edited.has(email) || edited.has(password) || (email.value && email.value !== defaults.email)) continue;
      applying = true;
      try {
        for (const [input, value] of [[email, defaults.email], [password, defaults.password]]) {
          if (input.value) continue;
          // The native setter and input event keep the controlled React form state in sync.
          setValue.call(input, value);
          input.dispatchEvent(new Event("input", { bubbles: true }));
        }
      } finally {
        applying = false;
      }
    }
  }

  document.addEventListener("input", (event) => {
    if (isLogin() && !applying && event.target instanceof HTMLInputElement) edited.add(event.target);
  }, true);
  const observer = new MutationObserver(fill);
  function start() {
    observer.disconnect();
    if (!isLogin()) return;
    observer.observe(document.body, { childList: true, subtree: true });
    loading ??= fetch("/js/selfhost-login.json", { cache: "no-store", credentials: "omit" })
      .then((response) => response.ok ? response.json() : null)
      .then((value) => {
        if (typeof value?.email === "string" && value.email && typeof value?.password === "string" && value.password) defaults = value;
      })
      .catch(() => {});
    void loading.then(fill);
  }
  window.addEventListener("hashchange", start);
  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", start, { once: true });
  else start();
})();
