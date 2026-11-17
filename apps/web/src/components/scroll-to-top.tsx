"use client";

import { useEffect, useState } from "react";
import { ArrowUp } from "lucide-react";
import { AnimatePresence, motion } from "motion/react";
import { Button } from "@/components/ui/button";
import { spring } from "@/lib/springs";

const SCROLL_THRESHOLD = 400;

export function ScrollToTop() {
  const [visible, setVisible] = useState(false);

  useEffect(() => {
    const updateVisibility = () => setVisible(window.scrollY > SCROLL_THRESHOLD);
    updateVisibility();
    window.addEventListener("scroll", updateVisibility, { passive: true });
    return () => window.removeEventListener("scroll", updateVisibility);
  }, []);

  return (
    <div className="pointer-events-none fixed inset-0 z-30">
      <AnimatePresence>
        {visible && (
          <motion.div
            key="scroll-to-top"
            className="absolute bottom-5 right-5 sm:bottom-8 sm:right-10"
            initial={{ opacity: 0, y: 8, scale: 0.96 }}
            animate={{ opacity: 1, y: 0, scale: 1 }}
            exit={{ opacity: 0, y: 8, scale: 0.96, transition: spring.moderate.exit }}
            transition={spring.moderate}
          >
            <Button
              type="button"
              size="icon"
              className="pointer-events-auto shadow-lg"
              aria-label="Scroll to top"
              title="Scroll to top"
              onClick={() =>
                window.scrollTo({
                  top: 0,
                  behavior: window.matchMedia("(prefers-reduced-motion: reduce)").matches
                    ? "instant"
                    : "smooth",
                })
              }
            >
              <ArrowUp aria-hidden="true" />
            </Button>
          </motion.div>
        )}
      </AnimatePresence>
    </div>
  );
}
