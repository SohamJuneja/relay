// The real widget, mounted on the page.
//
// Not a screenshot and not a mock: this imports `mount` from @relay/embed and runs
// the same code a partner's `<script>` tag would. A landing page that shows a
// picture of the product is asking to be believed; one that runs it is not.

import { useEffect, useRef } from "react";
import { mount, unmount } from "@relay/embed";
import { API_URL, DEMO_BUILDER, DEMO_PARTNER_ID } from "../config";

export function WidgetPreview(props: {
  /** Falsy mounts the configured demo partner, so a preview is never tagged with 0. */
  partner: number | undefined;
  builder: string | undefined;
  asset?: string;
  intervalSec?: number;
  surface?: string;
  /** Hide the widget's own question line when the surrounding page already asks it. */
  question?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { asset, intervalSec, surface, question } = props;
  // A preview with no partner of its own is the demo partner's — and its builder must
  // come from the same place, or the order is tagged with one identity and paid to
  // another.
  const partner = props.partner || DEMO_PARTNER_ID;
  const builder = props.partner ? (props.builder ?? DEMO_BUILDER) : DEMO_BUILDER;

  useEffect(() => {
    const el = host.current;
    if (!el) return;
    mount(el, {
      partner,
      builder: builder as `0x${string}`,
      api: API_URL,
      ...(asset ? { asset } : {}),
      ...(intervalSec ? { intervalSec } : {}),
      ...(surface ? { surface } : {}),
      ...(question === undefined ? {} : { question }),
    });
    return () => unmount(el);
  }, [partner, builder, asset, intervalSec, surface, question]);

  return <div ref={host} data-testid="widget-preview" />;
}
