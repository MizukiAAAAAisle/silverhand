import { useLayoutEffect, useRef, useState } from "react";

export function useProfileHeroSize() {
  const profileRef = useRef<HTMLDivElement>(null);
  const [compactHero, setCompactHero] = useState(true);

  useLayoutEffect(() => {
    const element = profileRef.current;

    if (!element) {
      return;
    }

    const updateWidth = () => setCompactHero(element.getBoundingClientRect().width <= 520);
    updateWidth();
    const observer = new ResizeObserver(updateWidth);
    observer.observe(element);

    return () => observer.disconnect();
  }, []);

  return { profileRef, compactHero };
}
