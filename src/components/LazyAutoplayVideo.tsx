import { useEffect, useRef, useState } from "react";
import { useReducedMotion } from "framer-motion";

interface LazyAutoplayVideoProps {
  src: string;
  className?: string;
  poster?: string;
}

export function LazyAutoplayVideo({ src, className, poster }: LazyAutoplayVideoProps) {
  const videoRef = useRef<HTMLVideoElement>(null);
  const [shouldLoad, setShouldLoad] = useState(false);
  const [isInView, setIsInView] = useState(false);
  const [hydrated, setHydrated] = useState(false);
  const prefersReducedMotion = useReducedMotion() ?? false;
  const reduceMotion = hydrated && prefersReducedMotion;

  useEffect(() => setHydrated(true), []);

  useEffect(() => {
    if (reduceMotion) {
      setIsInView(false);
      videoRef.current?.pause();
      return undefined;
    }

    const node = videoRef.current;
    if (!node) return undefined;

    if (!("IntersectionObserver" in window)) {
      setShouldLoad(true);
      setIsInView(true);
      return undefined;
    }

    const observer = new IntersectionObserver(
      ([entry]) => {
        const visible = entry?.isIntersecting === true;
        setIsInView(visible);
        if (visible) setShouldLoad(true);
      },
      { rootMargin: "240px 0px" },
    );
    observer.observe(node);

    return () => observer.disconnect();
  }, [reduceMotion]);

  useEffect(() => {
    const node = videoRef.current;
    if (!node) return;
    if (reduceMotion || !isInView || !shouldLoad) {
      node.pause();
      return;
    }
    const playback = node.play();
    if (playback && typeof playback.catch === "function") {
      void playback.catch(() => undefined);
    }
  }, [isInView, reduceMotion, shouldLoad]);

  return (
    <video
      ref={videoRef}
      muted
      loop={!reduceMotion}
      playsInline
      preload="none"
      aria-hidden="true"
      className={className}
      poster={shouldLoad ? poster : undefined}
      src={shouldLoad && !reduceMotion ? src : undefined}
    />
  );
}
