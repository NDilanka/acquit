import { createContext, useContext, useLayoutEffect } from "react";

export const PageTitleContext = createContext<((title: string | null) => void) | null>(null);

/** A page supplies its actual title to the shell's single h1, including titles read asynchronously. */
export function PageTitle({ children }: { children: string }) {
  const setTitle = useContext(PageTitleContext);
  useLayoutEffect(() => {
    setTitle?.(children);
    return () => setTitle?.(null);
  }, [children, setTitle]);
  return null;
}
