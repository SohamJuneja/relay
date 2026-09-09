// The real widget, mounted on the page.
//
// Not a screenshot and not a mock: this imports `mount` from @relay/embed and runs
// the same code a partner's `<script>` tag would. A landing page that shows a
// picture of the product is asking to be believed; one that runs it is not.

import { useEffect, useRef } from "react";
import { mount, unmount } from "@relay/embed";
import { API_URL } from "../config";

export function WidgetPreview(props: {
  partner: number;
  builder: string;
  asset?: string;
  intervalSec?: number;
  surface?: string;
  /** Hide the widget's own question line when the surrounding page already asks it. */
  question?: boolean;
}) {
  const host = useRef<HTMLDivElement>(null);
  const { partner, builder, asset, intervalSec, surface, question } = props;

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
