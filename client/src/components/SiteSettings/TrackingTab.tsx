"use client";

import { useQueryClient } from "@tanstack/react-query";
import { useExtracted } from "next-intl";
import { Fragment, type ReactNode, useCallback, useState } from "react";
import { toast } from "@/components/ui/sonner";

import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Switch } from "@/components/ui/switch";

import { updateSiteConfig, SiteResponse } from "@/api/admin/endpoints";
import { useGetSitesFromOrg } from "@/api/admin/hooks/useSites";
import { planIncludesReplay } from "@/lib/subscription/planUtils";
import { useStripeSubscription } from "@/lib/subscription/useStripeSubscription";
import { Badge } from "@/components/ui/badge";
import { IS_CLOUD } from "@/lib/const";

import { SettingRow, SettingsSection, SettingsSections } from "./SettingsSection";

interface TrackingTabProps {
  siteMetadata: SiteResponse;
  disabled?: boolean;
  adminSubscription?: { planName: string; eventLimit?: number };
  adminMode?: boolean;
}

interface ToggleConfig {
  id: string;
  label: string;
  description: string;
  value: boolean;
  key: keyof SiteResponse;
  enabledMessage?: string;
  disabledMessage?: string;
  errorMessage?: string;
  disabled?: boolean;
  badge?: ReactNode;
}

export function TrackingTab({
  siteMetadata,
  disabled = false,
  adminSubscription,
  adminMode = false,
}: TrackingTabProps) {
  const t = useExtracted();
  const queryClient = useQueryClient();
  const { refetch } = useGetSitesFromOrg(siteMetadata?.organizationId ?? "", { enabled: !adminMode });
  const isMobileSite = siteMetadata.type === "mobile";

  const [toggleStates, setToggleStates] = useState({
    sessionReplay: siteMetadata.sessionReplay || false,
    heatmaps: siteMetadata.heatmaps ?? false,
    webVitals: siteMetadata.webVitals || false,
    trackErrors: siteMetadata.trackErrors || false,
    trackOutbound: siteMetadata.trackOutbound ?? true,
    trackUrlParams: siteMetadata.trackUrlParams ?? true,
    trackUrlFragments: siteMetadata.trackUrlFragments ?? false,
    trackInitialPageView: siteMetadata.trackInitialPageView ?? true,
    trackSpaNavigation: siteMetadata.trackSpaNavigation ?? true,
    trackButtonClicks: siteMetadata.trackButtonClicks ?? false,
    trackCopy: siteMetadata.trackCopy ?? false,
    trackFormInteractions: siteMetadata.trackFormInteractions ?? false,
  });

  const [loadingStates, setLoadingStates] = useState<Record<string, boolean>>({});
  const [savedHeatmapSampleRate, setSavedHeatmapSampleRate] = useState(siteMetadata.heatmapSampleRate ?? 15);
  const [heatmapSampleRate, setHeatmapSampleRate] = useState(String(siteMetadata.heatmapSampleRate ?? 15));
  const parsedHeatmapSampleRate = heatmapSampleRate.trim() === "" ? NaN : Number(heatmapSampleRate);
  const heatmapSampleRateValid =
    Number.isFinite(parsedHeatmapSampleRate) && parsedHeatmapSampleRate >= 0 && parsedHeatmapSampleRate <= 100;

  const refreshSite = useCallback(() => {
    if (!adminMode) {
      refetch();
    } else {
      queryClient.invalidateQueries({ queryKey: ["admin-organizations"] });
    }
    // Prefix match so both string- and number-keyed useGetSite instances update.
    queryClient.invalidateQueries({ queryKey: ["get-site"] });
  }, [adminMode, refetch, queryClient]);

  const handleToggle = useCallback(
    async (
      key: keyof typeof toggleStates,
      checked: boolean,
      successMessage?: { enabled: string; disabled: string },
      errorMessage?: string
    ) => {
      setLoadingStates(prev => ({ ...prev, [key]: true }));
      try {
        await updateSiteConfig(siteMetadata.siteId, { [key]: checked });
        setToggleStates(prev => ({ ...prev, [key]: checked }));
        const message = successMessage
          ? checked
            ? successMessage.enabled
            : successMessage.disabled
          : `${key.replace(/([A-Z])/g, " $1").toLowerCase()} ${checked ? "enabled" : "disabled"}`;
        toast.success(message);
        refreshSite();
      } catch (error) {
        console.error(`Error updating ${key}:`, error);
        toast.error(errorMessage ?? `Failed to update ${key.replace(/([A-Z])/g, " $1").toLowerCase()}`);
        setToggleStates(prev => ({ ...prev, [key]: !checked }));
      } finally {
        setLoadingStates(prev => ({ ...prev, [key]: false }));
      }
    },
    [siteMetadata.siteId, refreshSite]
  );

  const handleHeatmapSampleRate = async () => {
    if (
      !heatmapSampleRateValid ||
      parsedHeatmapSampleRate === savedHeatmapSampleRate ||
      disabled ||
      loadingStates.heatmapSampleRate
    )
      return;
    setLoadingStates(prev => ({ ...prev, heatmapSampleRate: true }));
    try {
      await updateSiteConfig(siteMetadata.siteId, { heatmapSampleRate: parsedHeatmapSampleRate });
      setSavedHeatmapSampleRate(parsedHeatmapSampleRate);
      setHeatmapSampleRate(String(parsedHeatmapSampleRate));
      toast.success(t("Heatmap sample rate updated"));
      refreshSite();
    } catch (error) {
      console.error("Error updating heatmap sample rate:", error);
      setHeatmapSampleRate(String(savedHeatmapSampleRate));
      toast.error(t("Failed to update heatmap sample rate"));
    } finally {
      setLoadingStates(prev => ({ ...prev, heatmapSampleRate: false }));
    }
  };

  const { data: subscription, isLoading: isSubscriptionLoading } = useStripeSubscription();
  const effectiveSubscription = adminSubscription ?? subscription;
  const subscriptionLoading = adminMode ? false : isSubscriptionLoading;

  const sessionReplayDisabled = !planIncludesReplay(effectiveSubscription) && IS_CLOUD;

  const standardFeaturesDisabled =
    !effectiveSubscription?.planName.includes("custom") &&
    !effectiveSubscription?.planName.includes("standard") &&
    !effectiveSubscription?.planName.includes("pro") &&
    !effectiveSubscription?.planName.includes("appsumo") &&
    IS_CLOUD;

  const analyticsToggles: ToggleConfig[] = [
    // Hide the replay toggle for AppSumo tiers without replays (1-3); tiers 4-7 include them
    ...(!isMobileSite &&
    !subscriptionLoading &&
    (!effectiveSubscription?.planName?.startsWith("appsumo") || planIncludesReplay(effectiveSubscription))
      ? [
          {
            id: "sessionReplay",
            label: t("Session Replay"),
            description: t("Record and replay user sessions to understand user behavior"),
            value: toggleStates.sessionReplay,
            key: "sessionReplay",
            enabledMessage: t("Session replay enabled"),
            disabledMessage: t("Session replay disabled"),
            disabled: sessionReplayDisabled,
            badge: <Badge variant="success">Pro</Badge>,
          } as ToggleConfig,
        ]
      : []),
    ...(!isMobileSite
      ? [
          {
            id: "heatmaps",
            label: t("Heatmaps"),
            description: t("Collect clicks and scroll reach"),
            value: toggleStates.heatmaps,
            key: "heatmaps",
            enabledMessage: t("Heatmaps enabled"),
            disabledMessage: t("Heatmaps disabled"),
            errorMessage: t("Failed to update heatmaps"),
          } as ToggleConfig,
          {
            id: "webVitals",
            label: t("Web Vitals"),
            description: t("Track Core Web Vitals metrics (LCP, CLS, INP, FCP, TTFB)"),
            value: toggleStates.webVitals,
            key: "webVitals" as keyof SiteResponse,
            enabledMessage: t("Web Vitals enabled"),
            disabledMessage: t("Web Vitals disabled"),
            disabled: standardFeaturesDisabled,
            badge: <Badge variant="success">Standard</Badge>,
          } as ToggleConfig,
        ]
      : []),
    ...(!isMobileSite
      ? [
          {
            id: "trackSpaNavigation",
            label: t("SPA Navigation"),
            description: t("Automatically track navigation in single-page applications"),
            value: toggleStates.trackSpaNavigation,
            key: "trackSpaNavigation",
            enabledMessage: t("SPA navigation tracking enabled"),
            disabledMessage: t("SPA navigation tracking disabled"),
          } as ToggleConfig,
          {
            id: "trackUrlParams",
            label: t("URL Parameters"),
            description: t("Include query string parameters in page tracking"),
            value: toggleStates.trackUrlParams,
            key: "trackUrlParams",
            enabledMessage: t("URL parameters tracking enabled"),
            disabledMessage: t("URL parameters tracking disabled"),
          } as ToggleConfig,
          {
            id: "trackUrlFragments",
            label: t("Track URL fragments"),
            description: t(
              "Keep fragments such as #shipping in page paths to track checkout stages or tabs separately"
            ),
            value: toggleStates.trackUrlFragments,
            key: "trackUrlFragments",
            enabledMessage: t("URL fragment tracking enabled"),
            disabledMessage: t("URL fragment tracking disabled"),
          } as ToggleConfig,
        ]
      : []),
    {
      id: "trackInitialPageView",
      label: isMobileSite ? t("Initial Screen View") : t("Initial Page View"),
      description: isMobileSite
        ? t("Automatically track the initial screen passed to the React Native SDK")
        : t("Automatically track the first page view when the script loads"),
      value: toggleStates.trackInitialPageView,
      key: "trackInitialPageView",
      enabledMessage: t("Initial page view tracking enabled"),
      disabledMessage: t("Initial page view tracking disabled"),
    },
  ];

  const autoCaptureToggles: ToggleConfig[] = [
    ...(!isMobileSite
      ? [
          {
            id: "trackOutbound",
            label: t("Outbound Links"),
            description: t("Track when users click on external links"),
            value: toggleStates.trackOutbound,
            key: "trackOutbound",
            enabledMessage: t("Outbound tracking enabled"),
            disabledMessage: t("Outbound tracking disabled"),
          } as ToggleConfig,
        ]
      : []),
    {
      id: "trackErrors",
      label: t("Error Tracking"),
      description: isMobileSite
        ? t("Allow error events sent by the React Native SDK")
        : t("Capture JavaScript errors and exceptions from your site"),
      value: toggleStates.trackErrors,
      key: "trackErrors",
      enabledMessage: t("Error tracking enabled"),
      disabledMessage: t("Error tracking disabled"),
      disabled: standardFeaturesDisabled,
      badge: <Badge variant="success">Standard</Badge>,
    },
    ...(!isMobileSite
      ? [
          {
            id: "trackButtonClicks",
            label: t("Button Clicks"),
            description: t("Automatically track clicks on all buttons"),
            value: toggleStates.trackButtonClicks,
            key: "trackButtonClicks",
            enabledMessage: t("Button click tracking enabled"),
            disabledMessage: t("Button click tracking disabled"),
            disabled: standardFeaturesDisabled,
            badge: <Badge variant="success">Standard</Badge>,
          } as ToggleConfig,
          {
            id: "trackCopy",
            label: t("Copy Events"),
            description: t("Track when users copy text from your site"),
            value: toggleStates.trackCopy,
            key: "trackCopy",
            enabledMessage: t("Copy tracking enabled"),
            disabledMessage: t("Copy tracking disabled"),
            disabled: standardFeaturesDisabled,
            badge: <Badge variant="success">Standard</Badge>,
          } as ToggleConfig,
          {
            id: "trackFormInteractions",
            label: t("Form Interactions"),
            description: t("Automatically track form submissions and input/select changes"),
            value: toggleStates.trackFormInteractions,
            key: "trackFormInteractions",
            enabledMessage: t("Form interaction tracking enabled"),
            disabledMessage: t("Form interaction tracking disabled"),
            disabled: standardFeaturesDisabled,
            badge: <Badge variant="success">Standard</Badge>,
          } as ToggleConfig,
        ]
      : []),
  ];

  const heatmapSampleRateControl = (
    <SettingRow label={t("Heatmap sample rate")} htmlFor="heatmapSampleRate">
      <form
        className="flex items-center gap-2"
        onSubmit={event => {
          event.preventDefault();
          void handleHeatmapSampleRate();
        }}
      >
        <Input
          id="heatmapSampleRate"
          type="number"
          min={0}
          max={100}
          step="any"
          required
          aria-describedby="heatmapSampleRateUnit"
          className="w-20"
          value={heatmapSampleRate}
          disabled={disabled || loadingStates.heatmapSampleRate}
          onChange={event => setHeatmapSampleRate(event.target.value)}
        />
        <span id="heatmapSampleRateUnit" className="text-sm text-muted-foreground">
          %
        </span>
        <Button
          type="submit"
          size="sm"
          variant="secondary"
          disabled={
            disabled ||
            loadingStates.heatmapSampleRate ||
            !heatmapSampleRateValid ||
            parsedHeatmapSampleRate === savedHeatmapSampleRate
          }
        >
          {t("Save")}
        </Button>
      </form>
    </SettingRow>
  );

  const renderToggleSection = (toggles: ToggleConfig[], title: string) => (
    <SettingsSection title={title}>
      {toggles.map(toggle => (
        <Fragment key={toggle.id}>
          <SettingRow
            label={toggle.label}
            htmlFor={toggle.id}
            description={toggle.description}
            badge={IS_CLOUD ? toggle.badge : undefined}
          >
            <Switch
              id={toggle.id}
              checked={toggle.value}
              disabled={loadingStates[toggle.key] || disabled || toggle.disabled}
              onCheckedChange={checked =>
                handleToggle(
                  toggle.key as keyof typeof toggleStates,
                  checked,
                  toggle.enabledMessage && toggle.disabledMessage
                    ? { enabled: toggle.enabledMessage, disabled: toggle.disabledMessage }
                    : undefined,
                  toggle.errorMessage
                )
              }
            />
          </SettingRow>
          {toggle.id === "heatmaps" && heatmapSampleRateControl}
        </Fragment>
      ))}
    </SettingsSection>
  );

  return (
    <SettingsSections>
      {renderToggleSection(analyticsToggles, t("Analytics Features"))}
      {renderToggleSection(autoCaptureToggles, t("Auto Capture"))}
    </SettingsSections>
  );
}
