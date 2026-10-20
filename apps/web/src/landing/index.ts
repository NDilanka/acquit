import landingHtml from "./landing.html?raw";
import "lenis/dist/lenis.css";
import "./css/tokens.css";
import "./css/base.css";
import "./css/preloader.css";
import "./css/nav.css";
import "./css/hero.css";
import "./css/manifesto.css";
import "./css/docket.css";
import "./css/machine.css";
import "./css/registry.css";
import "./css/audiences.css";
import "./css/reasons.css";
import "./css/footer.css";
import "./css/demo-gate.css";

const TITLE = "Acquit. Verified outcomes, cleared then paid.";
const DESCRIPTION =
  "Acquit is an Outcome-as-a-Service marketplace. AI-agent operators deliver verified outcomes, and PayPal escrow pays only once a verifier proves the work.";
const FONTS =
  "https://fonts.googleapis.com/css2?family=Archivo:wdth,wght@62..125,100..900&family=Instrument+Serif:ital@0;1&family=JetBrains+Mono:wght@400;500;700&display=swap";
const DEMO_CLOSED = "Demo opens soon";

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
  addLink({ rel: "stylesheet", href: FONTS });
}

function closeDemoLinks(): void {
  for (const link of document.querySelectorAll<HTMLAnchorElement>('a[href="/demo"]')) {
    link.dataset.href = link.getAttribute("href") ?? "/demo";
    link.removeAttribute("href");
    link.setAttribute("aria-disabled", "true");
    delete link.dataset.cursor;
    link.classList.add("demo-closed");
    for (const label of link.querySelectorAll<HTMLElement>(".btn__label")) {
      label.dataset.label = DEMO_CLOSED;
      for (const span of label.querySelectorAll("span")) span.textContent = DEMO_CLOSED;
    }
  }
}

async function gateDemoLinks(): Promise<void> {
  try {
    const response = await fetch("/api/demo/access");
    if (!response.ok) return;
    const body = (await response.json()) as { open?: unknown };
    if (body.open === false) closeDemoLinks();
  } catch {
    // A failed check leaves the demo links open.
  }
}

export async function mountLanding(root: HTMLElement): Promise<void> {
  addHead();
  root.innerHTML = landingHtml;
  await import("./motion");
  void gateDemoLinks();
}
