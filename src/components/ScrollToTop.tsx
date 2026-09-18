import { useEffect } from "react";
import { useLocation } from "react-router-dom";

const ScrollToTop = () => {
  const { pathname, search, hash } = useLocation();

  useEffect(() => {
    const html = document.documentElement;
    html.dataset.appReadiness = "navigating";
    delete html.dataset.appRoute;
    const timer = window.setTimeout(() => {
      html.dataset.appRoute = `${pathname}${search}${hash}`;
      html.dataset.appReadiness = "ready";
    }, 1_500);
    if (!hash) {
      window.scrollTo(0, 0);
    }
    return () => window.clearTimeout(timer);
  }, [pathname, search, hash]);

  return null;
};

export default ScrollToTop;
