import { createElement, useEffect, useId, useState, useRef, type ReactNode } from "react";
import { useNativeHost } from "./nativeHostContext";
import { BackHandler } from "./environment";
import { Animated, Easing } from "../animation/legacyAnimated";
import { RokuHostError } from "../scene/sceneGraph.types";
import type { AccessibilityProps } from "./accessibility";
let sequence = 0;
interface ModalProps extends AccessibilityProps {
  readonly children?: ReactNode;
  readonly visible?: boolean;
  readonly transparent?: boolean;
  readonly animationType?: "none" | "fade" | "slide";
  readonly onShow?: () => void;
  readonly onRequestClose?: () => void;
  readonly onDismiss?: () => void;
}
/** Roku has one scene viewport. React portals preserve context and escape parent clips. */
export function Modal({
  children,
  visible = true,
  transparent = false,
  animationType = "none",
  onShow,
  onRequestClose,
  onDismiss,
  ...accessibility
}: ModalProps) {
  const host = useNativeHost(),
    id = useId(),
    [order, setOrder] = useState(() => ++sequence),
    [present, setPresent] = useState(visible),
    [progress] = useState(() => new Animated.Value(animationType === "none" ? 1 : 0));
  const callbacks = useRef({ onShow, onRequestClose, onDismiss });
  const presentation = useRef(0);
  callbacks.current = { onShow, onRequestClose, onDismiss };
  // A newly presented sibling belongs above already presented siblings.
  // Adjust this component's state before reconciling its portal children so
  // nested modals receive their later order. A closing reversal keeps the
  // existing presentation and cannot jump above its retained nested modal.
  if (visible && !present) {
    setPresent(true);
    setOrder(++sequence);
  }
  if (!["none", "fade", "slide"].includes(animationType))
    throw new RokuHostError(
      "C03_MODAL_ANIMATION",
      "The modal animation must be none, fade or slide",
    );
  const mounted = visible || (animationType !== "none" && present);
  const modalID = `roku-modal-${id}`;
  useEffect(() => {
    if (!mounted) return;
    presentation.current++;
    const subscription = BackHandler.addEventListener("hardwareBackPress", () => {
      // Effect registration order can differ from paint order. The presented
      // portal keeps Back when a dialog inside it isolates accessibility or
      // while the portal finishes its closing animation.
      const placement = host.placement(modalID);
      if (
        !host.active ||
        !placement ||
        placement.visible === false ||
        (placement.modalBlocked && !placement.containsActiveModalScope)
      )
        return false;
      callbacks.current.onRequestClose?.();
      return true;
    });
    return () => {
      subscription.remove();
      const generation = ++presentation.current;
      void host.whenCommitted().then(
        () => {
          if (presentation.current === generation) callbacks.current.onDismiss?.();
        },
        () => {},
      );
    };
  }, [host, mounted, modalID]);
  useEffect(() => {
    let active = true;
    if (visible) setPresent(true);
    else if (!present) return;
    void host.whenCommitted().then(
      () => {
        if (!active) return;
        const complete = () => {
          if (!active) return;
          if (visible) callbacks.current.onShow?.();
          else setPresent(false);
        };
        if (animationType === "none") {
          progress.setValue(visible ? 1 : 0);
          complete();
        } else {
          Animated.timing(progress, {
            toValue: visible ? 1 : 0,
            duration: 300,
            easing: Easing.linear,
          }).start(({ finished }) => {
            if (finished) complete();
          });
        }
      },
      () => {},
    );
    return () => {
      active = false;
      progress.stopAnimation();
    };
  }, [host, visible, animationType, progress]);
  return mounted
    ? host.portal(
        createElement(
          Animated.View,
          {
            ...accessibility,
            nativeID: modalID,
            accessibilityViewIsModal: true,
            "aria-modal": true,
            style: {
              position: "absolute",
              left: 0,
              top: 0,
              width: host.viewport.width,
              height: host.viewport.height,
              zIndex: 100000 + order,
              backgroundColor: transparent ? "transparent" : "white",
              opacity: animationType === "fade" ? progress : 1,
              transform:
                animationType === "slide"
                  ? [
                      {
                        translateY: Animated.multiply(
                          Animated.subtract(1, progress),
                          host.viewport.height,
                        ),
                      },
                    ]
                  : [],
            },
          },
          children,
        ),
        id,
      )
    : null;
}
