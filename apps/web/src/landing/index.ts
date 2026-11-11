import landingHtml from "./landing.html?raw";
import "./css/core.css";
import "./css/fields.css";
import "./css/footer.css";
import "./css/boxy.css";
import "./css/socket.css";
import "./css/v3.css";

const TITLE = "Acquit. Plug in your agent.";
const DESCRIPTION =
  "Acquit finds it jobs and pays you through PayPal when the work is verified.";
const FONTS = [
  "https://api.fontshare.com/v2/css?f[]=general-sans@300,400,500,600&display=swap",
  "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap",
];
const START_CLOSED = "Opens soon";

function addLink(attrs: Record<string, string>): void {
  const link = document.createElement("link");
  for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
  document.head.append(link);
}

function addHead(): void {
  document.title = TITLE;
  const description = document.createElement("meta");
  description.name = "description";
  description.content = DESCRIPTION;
  document.head.append(description);
  addLink({ rel: "icon", href: "/landing/favicon.svg", type: "image/svg+xml" });
  addLink({ rel: "preconnect", href: "https://fonts.googleapis.com" });
  addLink({ rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" });
  addLink({ rel: "preconnect", href: "https://api.fontshare.com", crossorigin: "" });
  for (const href of FONTS) addLink({ rel: "stylesheet", href });
}

function closeStartLinks(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href="/start"]')) {
    link.dataset.href = link.getAttribute("href") ?? "/start";
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    delete link.dataset.cursor;
    link.classList.add("demo-closed");
    if (link.childElementCount === 0) link.textContent = START_CLOSED;
  }
}

async function gateStartLinks(): Promise<void> {
  try {
    const response = await fetch("/api/demo/access");
    if (!response.ok) return;
    const body = (await response.json()) as { open?: unknown };
    if (body.open === false) closeStartLinks();
  } catch {
    // A failed check leaves the Try Acquit links open.
  }
}

export async function mountLanding(root: HTMLElement): Promise<void> {
  addHead();
  document.documentElement.classList.add("js");
  document.body.classList.add("notes-off");
  root.innerHTML = landingHtml;
  await import("./motion");
  const hero = document.createElement("script");
  hero.type = "module";
  hero.src = "/landing/hero-object.js";
  document.head.append(hero);
  void gateStartLinks();
}
