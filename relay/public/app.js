document.documentElement.classList.add("js");

const $ = (id) => document.getElementById(id);

/** Confirmation dialog instead of the system confirm. */
function ask(title, text, action) {
  return new Promise((resolve) => {
    const dialog = $("confirm-dialog");
    $("confirm-title").textContent = title;
    $("confirm-text").textContent = text;
    $("confirm-yes").textContent = action;
    const yes = () => {
      dialog.close();
      resolve(true);
    };
    $("confirm-yes").addEventListener("click", yes, { once: true });
    dialog.addEventListener("close", () => {
      $("confirm-yes").removeEventListener("click", yes);
      resolve(false);
    }, { once: true });
    dialog.showModal();
  });
}

/** The browser may refuse clipboard access, so the button says so. */
async function copyText(button, text) {
  try {
    await navigator.clipboard.writeText(text);
    button.textContent = "Copied";
  } catch {
    button.textContent = "Copy failed";
  }
  setTimeout(() => { button.textContent = "Copy"; }, 1500);
}

function showError(element, message) {
  element.textContent = message;
  element.hidden = !message;
}

async function api(path, options = {}) {
  const response = await fetch(path, {
    ...options,
    headers: options.body ? { "content-type": "application/json" } : undefined,
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
  if (response.status === 204) return null;
  const data = await response.json().catch(() => null);
  if (!response.ok) {
    const error = new Error(data?.error?.message ?? `Something went wrong (${response.status})`);
    error.status = response.status;
    throw error;
  }
  return data;
}

const clients = (url) => [
  {
    name: "ChatGPT",
    steps: [
      ['Open <a href="https://chatgpt.com/plugins" rel="noopener">chatgpt.com/plugins</a>. Custom servers may require Developer mode in Settings.'],
      ["Add a custom connector and paste this address:", url],
      ["Choose OAuth if asked, then sign in on the Herb page and tap Connect."],
    ],
  },
  {
    name: "Claude",
    steps: [
      ['Open <a href="https://claude.ai/customize/connectors" rel="noopener">claude.ai connectors</a>.'],
      ["Add a custom connector with this address:", url],
      ["Tap Connect, sign in on the Herb page and confirm."],
    ],
  },
  {
    name: "Grok Bot",
    steps: [
      ["In a Grok Bot chat, send:", `Add a custom MCP server called herb at ${url}`],
      ["Confirm with Add it, tap Authorize, sign in on the Herb page and confirm."],
    ],
  },
  {
    name: "Codex",
    steps: [["Run:", `codex mcp add herb --url ${url}`], ["Sign in on the Herb page that opens and confirm."]],
  },
  {
    name: "Claude Code",
    steps: [["Run:", `claude mcp add --transport http herb ${url}`], ["Run /mcp in Claude Code, sign in on the Herb page and confirm."]],
  },
  {
    name: "Script",
    steps: [["Create an API token below, then:", `curl -X POST ${new URL(url).origin}/v1/call -H "Authorization: Bearer $TOKEN"`]],
  },
];

function renderClients(url) {
  const tabs = $("client-tabs");
  const panel = $("client-steps");
  const list = clients(url);
  tabs.replaceChildren();
  const select = (index) => {
    [...tabs.children].forEach((tab, i) => tab.setAttribute("aria-selected", String(i === index)));
    const steps = document.createElement("ol");
    for (const [text, code] of list[index].steps) {
      const item = document.createElement("li");
      // Steps are defined above and hold no user data. The server address goes in code, as text.
      item.innerHTML = text;
      if (code) {
        const block = document.createElement("code");
        block.textContent = code;
        item.append(block);
      }
      steps.append(item);
    }
    panel.replaceChildren(steps);
  };
  list.forEach((client, index) => {
    const tab = document.createElement("button");
    tab.type = "button";
    tab.role = "tab";
    tab.className = "tab";
    tab.textContent = client.name;
    tab.addEventListener("click", () => select(index));
    tabs.append(tab);
  });
  select(0);
}

function row(mainText, subText, action) {
  const item = document.createElement("li");
  const main = document.createElement("span");
  main.className = "item-main";
  main.textContent = mainText;
  if (subText) {
    const sub = document.createElement("span");
    sub.className = "item-sub";
    sub.textContent = subText;
    main.append(sub);
  }
  item.append(main);
  if (action) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = "button button-ghost button-sm";
    button.textContent = action.label;
    button.setAttribute("aria-label", `${action.label} ${mainText}`);
    button.addEventListener("click", action.run);
    item.append(button);
  }
  return item;
}

function fill(listId, emptyId, items) {
  $(listId).replaceChildren(...items);
  $(emptyId).hidden = items.length > 0;
}

const when = (ms) => new Date(ms).toLocaleString(undefined, { dateStyle: "medium", timeStyle: "short" });
const STATUS = { ringing: "Ringing", answered: "Answered", played: "Played", declined: "Declined", missed: "Missed", failed: "Failed" };

async function refresh() {
  const [status, bots, devices, calls] = await Promise.all([
    api("/v1/status"),
    api("/v1/bots"),
    api("/v1/devices"),
    api("/v1/calls?limit=20"),
  ]);
  accountId = status.account_id;
  renderKey();
  const url = status.mcp_url ?? `${location.origin}/mcp`;
  if ($("mcp-url").textContent !== url) {
    $("mcp-url").textContent = url;
    renderClients(url);
  }
  fill("agents", "agents-empty", bots.bots.map((bot) => row(bot.name, null, {
    label: "Remove",
    run: async () => {
      if (!(await ask(`Remove ${bot.name}?`, "It will no longer be able to call you. Its call history is deleted.", "Remove"))) return;
      await api(`/v1/bots/${bot.id}`, { method: "DELETE" });
      await refresh();
    },
  })));
  fill("phones", "phones-empty", devices.devices.map((phone) => row(phone.name, phone.push ? null : "Rings only while the app is open", {
    label: "Remove",
    run: async () => {
      if (!(await ask(`Remove ${phone.name}?`, "It will stop ringing and sign out.", "Remove"))) return;
      await api(`/v1/devices/${phone.id}`, { method: "DELETE" });
      await refresh();
    },
  })));
  fill("calls", "calls-empty", calls.calls.map((call) => row(
    call.title ?? call.bot_name,
    [call.title && call.title !== call.bot_name ? call.bot_name : null, STATUS[call.status] ?? call.status, when(call.created_at)].filter(Boolean).join(" · "),
  )));
}

const CONFIG_PATH = "/config";
const LANDING_TITLE = document.title;
let signedIn = false;

function renderNav(onConfig) {
  document.querySelectorAll(".landing-only").forEach((link) => { link.hidden = onConfig; });
  $("open-sign-in").hidden = signedIn;
  $("nav-configure").hidden = !signedIn || onConfig;
  $("sign-out").hidden = !signedIn;
  // On the landing page a signed in visitor should not create a second account.
  document.querySelectorAll(".create-account").forEach((button) => {
    button.textContent = signedIn ? "Open configuration" : "Create free account";
  });
}

function show(onConfig) {
  $("welcome").hidden = onConfig;
  $("dashboard").hidden = !onConfig;
  document.title = onConfig ? "Configure | Herb" : LANDING_TITLE;
  renderNav(onConfig);
  if (!location.hash) window.scrollTo(0, 0);
}

function navigate(path) {
  if (location.pathname !== path) history.pushState(null, "", path);
  return route();
}

/** The landing page is open to everyone. Configuration needs a session. */
async function route() {
  const wantsConfig = location.pathname === CONFIG_PATH;
  showAuthError("");
  try {
    await refresh();
    signedIn = true;
  } catch (error) {
    signedIn = false;
    if (error.status !== 401) showAuthError(error.message);
  }
  if (wantsConfig && !signedIn) {
    history.replaceState(null, "", "/");
    show(false);
    $("sign-in-dialog").showModal();
    return;
  }
  show(wantsConfig);
}

function showAuthError(message) {
  document.querySelectorAll(".auth-error").forEach((element) => showError(element, message));
}

document.querySelectorAll(".create-account").forEach((button) => {
  button.addEventListener("click", async () => {
    if (signedIn) {
      await navigate(CONFIG_PATH);
      return;
    }
    showAuthError("");
    try {
      const { key } = await api("/web/signup", { method: "POST" });
      forgetKey();
      pendingKey = key;
      $("new-key-value").textContent = key;
      $("new-key").hidden = false;
      await navigate(CONFIG_PATH);
    } catch (error) {
      showAuthError(error.message);
    }
  });
});

$("open-sign-in").addEventListener("click", () => {
  showError($("sign-in-error"), "");
  $("sign-in-dialog").showModal();
});

document.querySelectorAll("[data-close-dialog]").forEach((button) => {
  button.addEventListener("click", () => button.closest("dialog").close());
});

$("sign-in").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError($("sign-in-error"), "");
  try {
    const typed = $("key-input").value.trim();
    await api("/web/login", { method: "POST", body: { key: typed } });
    forgetKey();
    pendingKey = typed;
    $("key-input").value = "";
    $("sign-in-dialog").close();
    await navigate(CONFIG_PATH);
  } catch (error) {
    showError($("sign-in-error"), error.message);
  }
});

$("nav-configure").addEventListener("click", (event) => {
  event.preventDefault();
  navigate(CONFIG_PATH);
});

window.addEventListener("popstate", route);

$("sign-out").addEventListener("click", async () => {
  await api("/web/logout", { method: "POST" });
  forgetKey();
  $("new-key").hidden = true;
  await navigate("/");
});

$("key-saved").addEventListener("click", () => {
  $("new-key").hidden = true;
  $("new-key-value").textContent = "";
});

$("create-token").addEventListener("submit", async (event) => {
  event.preventDefault();
  showError($("token-error"), "");
  try {
    const { token } = await api("/v1/bots", { method: "POST", body: { name: $("token-name").value } });
    $("token-value").textContent = token;
    $("token-result").hidden = false;
    $("token-name").value = "";
    await refresh();
  } catch (error) {
    showError($("token-error"), error.message);
  }
});

$("delete-account").addEventListener("click", async () => {
  if (!(await ask("Delete your account?", "Your agents, phones and call history are deleted. This cannot be undone.", "Delete account"))) return;
  showError($("account-error"), "");
  try {
    await api("/v1/account", { method: "DELETE" });
    forgetKey();
    $("new-key").hidden = true;
    await navigate("/");
  } catch (error) {
    showError($("account-error"), error.message);
  }
});

document.addEventListener("click", async (event) => {
  const button = event.target.closest("[data-copy-from]");
  if (!button) return;
  await copyText(button, $(button.dataset.copyFrom).textContent);
});

// The key lives only in this browser. The server keeps just a hash and cannot show it.
const KEY_STORAGE = "herb.account";
const KEY_MASK = "•••• •••• •••• •••• ••••";
let accountId = null;
let pendingKey = null;
let keyVisible = false;

function readStoredKey() {
  try {
    const stored = JSON.parse(localStorage.getItem(KEY_STORAGE));
    return stored?.id === accountId ? stored.key : null;
  } catch {
    return null;
  }
}

function forgetKey() {
  pendingKey = null;
  keyVisible = false;
  try {
    localStorage.removeItem(KEY_STORAGE);
  } catch {
    // Browser storage may be unavailable, and then nothing was stored.
  }
}

function renderKey() {
  if (pendingKey) {
    try {
      localStorage.setItem(KEY_STORAGE, JSON.stringify({ id: accountId, key: pendingKey }));
    } catch {
      // Without storage the key stays in this tab only.
    }
  }
  const key = pendingKey ?? readStoredKey();
  $("key-panel").hidden = !key;
  if (!key) return;
  $("key-value").textContent = keyVisible ? key : KEY_MASK;
  $("key-toggle").textContent = keyVisible ? "Hide" : "Show";
}

$("key-toggle").addEventListener("click", () => {
  keyVisible = !keyVisible;
  renderKey();
});

$("key-copy").addEventListener("click", async () => {
  await copyText($("key-copy"), pendingKey ?? readStoredKey() ?? "");
});

const CALL_PROGRESS = {
  ringing: "Ringing your phone",
  answered: "Answered",
  played: "Message played to the end",
  declined: "You declined the call",
  missed: "No answer",
  failed: "The call failed",
};
const PUSH_PROBLEM = {
  no_device: "No phone is signed in. Sign in to the Herb app with your account key.",
  failed: "Your phone did not get the call. Open the Herb app once and try again.",
  disabled: "Ringing. This server has no push key, so the Herb app must be open.",
};

$("test-call").addEventListener("submit", async (event) => {
  event.preventDefault();
  const status = $("test-status");
  const submit = $("test-submit");
  showError($("test-error"), "");
  submit.disabled = true;
  status.hidden = true;
  try {
    const call = await api("/v1/test-call", { method: "POST", body: { text: $("test-text").value } });
    // With no phone to ring, do not wait out the ring timeout.
    if (call.push === "no_device" || call.push === "failed") {
      showError($("test-error"), PUSH_PROBLEM[call.push]);
      await refresh();
      return;
    }
    status.textContent = PUSH_PROBLEM[call.push] ?? CALL_PROGRESS.ringing;
    status.hidden = false;
    await refresh();
    // A call rings for up to a minute, plus the time to play the message.
    const deadline = Date.now() + 180_000;
    let last = call.status;
    while (Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 2000));
      const current = await api(`/v1/calls/${call.id}`);
      if (current.status !== last) {
        last = current.status;
        status.textContent = CALL_PROGRESS[last] ?? last;
        await refresh();
      }
      if (["played", "declined", "missed", "failed"].includes(last)) break;
      // A call without a message ends when answered.
      if (last === "answered" && !$("test-text").value.trim()) break;
    }
  } catch (error) {
    status.hidden = true;
    showError($("test-error"), error.message);
  } finally {
    submit.disabled = false;
  }
});

// Sections reveal once on scroll.
const revealObserver = new IntersectionObserver((entries, observer) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("in");
    observer.unobserve(entry.target);
  }
}, { rootMargin: "0px 0px -10% 0px" });
document.querySelectorAll(".reveal").forEach((element) => revealObserver.observe(element));

// The tagline lights up word by word as each line crosses a trigger line.
const tagline = $("tagline");
const lines = tagline.innerHTML.split("<br>");
tagline.replaceChildren();
tagline.setAttribute("aria-label", lines.join(" "));
lines.forEach((line, lineIndex) => {
  if (lineIndex > 0) tagline.append(document.createElement("br"));
  line.split(" ").forEach((text, wordIndex) => {
    if (wordIndex > 0) tagline.append(" ");
    const word = document.createElement("span");
    word.className = "word";
    word.setAttribute("aria-hidden", "true");
    word.textContent = text;
    tagline.append(word);
  });
});
const wordObserver = new IntersectionObserver((entries) => {
  for (const entry of entries) {
    if (!entry.isIntersecting) continue;
    entry.target.classList.add("on");
    wordObserver.unobserve(entry.target);
  }
}, { rootMargin: "0px 0px -35% 0px" });
const words = [...tagline.querySelectorAll(".word")];
// Observe every word of the tagline.
words.forEach((word, index) => {
  word.dataset.index = String(index);
  wordObserver.observe(word);
});

route();
