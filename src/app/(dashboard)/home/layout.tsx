import { SectionI18nProvider } from "@/i18n/SectionI18nProvider";
import sectionNamespaces from "@/i18n/routeNamespaces.generated.json";

/**
 * /home route section i18n provider — mirrors the dashboard home set: the
 * /home page renders the same client components as /dashboard (HomePageClient
 * + sponsor banners) and needs the identical namespace scope.
 */
export default function HomeRouteLayout({ children }: { children: React.ReactNode }) {
  return <SectionI18nProvider namespaces={sectionNamespaces.home}>{children}</SectionI18nProvider>;
}
