import { Skeleton } from '../components/Skeleton.tsx';

/** Fallback of Suspense around lazy routes and of the shell before the first instance load. */
export function PageSkeleton() {
  return (
    <div className="page-skeleton">
      <Skeleton rows={8} variant="table" label="Loading page" />
    </div>
  );
}
