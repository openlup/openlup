import * as React from "react";

const MOTION_PROPS = new Set([
  "animate",
  "custom",
  "drag",
  "dragConstraints",
  "dragControls",
  "dragElastic",
  "dragListener",
  "dragMomentum",
  "dragSnapToOrigin",
  "exit",
  "initial",
  "layout",
  "layoutDependency",
  "layoutId",
  "onAnimationComplete",
  "onAnimationStart",
  "onDrag",
  "onDragEnd",
  "onDragStart",
  "onHoverEnd",
  "onHoverStart",
  "onTap",
  "onTapCancel",
  "onTapStart",
  "transformTemplate",
  "transition",
  "variants",
  "viewport",
  "whileDrag",
  "whileFocus",
  "whileHover",
  "whileInView",
  "whileTap",
]);

function stripMotionProps(props: Record<string, unknown>) {
  const domProps: Record<string, unknown> = {};

  for (const [key, value] of Object.entries(props)) {
    if (MOTION_PROPS.has(key)) continue;
    domProps[key] = value;
  }

  return domProps;
}

function createMotionElement(tag: string) {
  const MotionElement = React.forwardRef<HTMLElement, Record<string, unknown> & { children?: React.ReactNode }>(
    ({ children, ...props }, ref) =>
      React.createElement(tag, { ...stripMotionProps(props), ref }, children as React.ReactNode),
  );

  MotionElement.displayName = `MockMotion.${tag}`;
  return MotionElement;
}

export function createFramerMotionMock() {
  const cache = new Map<string, React.ComponentType<Record<string, unknown> & { children?: React.ReactNode }>>();

  return {
    AnimatePresence: ({ children }: { children: React.ReactNode }) => <>{children}</>,
    motion: new Proxy(
      {},
      {
        get(_target, tag: string) {
          if (!cache.has(tag)) {
            cache.set(tag, createMotionElement(tag));
          }
          return cache.get(tag);
        },
      },
    ),
    useInView: () => true,
    useReducedMotion: () => false,
  };
}
