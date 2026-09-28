import { TopBar } from "@/components/shell";
import { Card } from "@/components/ui";

/** A screen that has not moved to this interface yet. It still works in the previous one,
 *  served through /v2 by the same engine, so nothing is out of reach while it is moved. */
export function NotMoved({ title, hash }: { title: string; hash: string }) {
  return (
    <>
      <TopBar title={title} />
      <div className="page">
        <Card title="Not moved yet" label="Phase 2">
          <div className="not-moved">
            <p className="muted">
              This screen is still in the previous interface. Everything on it works there, against
              the same engine and the same data.
            </p>
            <a className="ctl solid" href={`/v2#/${hash}`}>
              Open {title} in the current interface
            </a>
          </div>
        </Card>
      </div>
    </>
  );
}
