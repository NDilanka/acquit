/** Same font requests as the landing, loaded only for the product entry. */
export function loadProductFonts(): void {
  const links: ReadonlyArray<Record<string, string>> = [
    { rel: "preconnect", href: "https://fonts.googleapis.com" },
    { rel: "preconnect", href: "https://fonts.gstatic.com", crossorigin: "" },
    { rel: "preconnect", href: "https://api.fontshare.com", crossorigin: "" },
    { rel: "stylesheet", href: "https://api.fontshare.com/v2/css?f[]=general-sans@300,400,500,600&display=swap" },
    { rel: "stylesheet", href: "https://fonts.googleapis.com/css2?family=Geist+Mono:wght@400;500&display=swap" },
  ];
  for (const attrs of links) {
    const link = document.createElement("link");
    for (const [name, value] of Object.entries(attrs)) link.setAttribute(name, value);
    document.head.append(link);
  }
}
