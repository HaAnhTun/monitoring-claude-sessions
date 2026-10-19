import { Skeleton } from '../components/Skeleton.tsx';
import { useT } from '../i18n/context.ts';

/** Fallback of Suspense around lazy routes and of the shell before the first instance load. */
export function PageSkeleton() {
  const t = useT();
  return (
    <div className="page-skeleton">
      <Skeleton rows={8} variant="table" label={t('common.loadingPage')} />
    </div>
  );
}
