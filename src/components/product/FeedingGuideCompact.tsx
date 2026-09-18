import type { StorefrontItem } from "@/domains/catalog/storefrontItemModel";
import { useTranslation } from "react-i18next";

import {
  portionSilhouetteCanineSmall as dogSmall,
  portionSilhouetteCanineMedium as dogMedium,
  portionSilhouetteCanineLarge as dogLarge,
  portionSilhouetteCanineExtraLarge as dogXlarge,
  portionSilhouetteFelineSmall as catSmall,
  portionSilhouetteFelineMedium as catMedium,
  portionSilhouetteFelineLarge as catLarge,
} from "#deployment-media";

interface Props {
  product: StorefrontItem;
}

const dogSilhouettes = [dogXlarge, dogMedium, dogSmall, dogLarge];
const catSilhouettes = [catSmall, catMedium, catLarge];
const dogMaxH = [42, 56, 70, 84];
const catMaxH = [42, 50, 58];

const weightKeyMap: Record<string, string> = {
  "Up to 8 kg": "catalog:product.feedingWeightUpTo8",
  "9–15 kg": "catalog:product.feedingWeight9to15",
  "16–25 kg": "catalog:product.feedingWeight16to25",
  "25+ kg": "catalog:product.feedingWeight25plus",
  "3–4 kg": "catalog:product.feedingWeight3to4",
  "4–6 kg": "catalog:product.feedingWeight4to6",
  "6 kg+": "catalog:product.feedingWeight6plus",
};

const amountKeyMap: Record<string, string> = {
  "½ can": "catalog:product.feedingHalfCan",
  "¾ can": "catalog:product.feedingThreeQuarterCan",
  "1 can": "catalog:product.feedingOneCan",
  "1½ cans": "catalog:product.feedingOneAndHalfCans",
  "1 jar": "catalog:product.feedingOneJar",
  "1 to 1¼ jars": "catalog:product.feedingOneToOneQuarterJars",
  "1¼ to 1½ jars": "catalog:product.feedingOneQuarterToOneHalfJars",
};

const FeedingGuideCompact = ({ product }: Props) => {
  const { t } = useTranslation("catalog");
  const isCat = product.species === "Cat";
  const silhouettes = isCat ? catSilhouettes : dogSilhouettes;
  const maxHeights = isCat ? catMaxH : dogMaxH;
  const tallest = Math.max(...maxHeights);
  const colCount = product.servingGuide.length;

  const feedingNoteKey = isCat ? "catalog:product.feedingNoteCat" : "catalog:product.feedingNoteDog";

  return (
    <div>
      <p className="text-xs tracking-[0.14em] uppercase text-center mb-8" style={{ color: "#1a8a84" }}>
        {t("catalog:product.feedingGuide")}
      </p>

      <div
        className="gap-4 md:gap-6 max-w-[700px] mx-auto grid"
        style={{ gridTemplateColumns: `repeat(${colCount}, 1fr)` }}
      >
        {product.servingGuide.map((row, i) => {
          const idx = Math.min(i, silhouettes.length - 1);
          const h = maxHeights[idx] ?? maxHeights[maxHeights.length - 1];
          return (
            <div key={row.weight} className="flex flex-col items-center text-center">
              <div
                className="mb-3 flex items-end justify-center w-full"
                style={{ height: `${tallest}px` }}
              >
                <img
                  src={silhouettes[idx]}
                  alt={`${isCat ? t("catalog:product.catBadge") : t("catalog:product.dogBadge")} silhouette`}
                  style={{
                    height: `${h}px`,
                    width: "auto",
                    filter: "brightness(0) saturate(100%) invert(43%) sepia(81%) saturate(391%) hue-rotate(140deg) brightness(92%) contrast(88%)",
                  }}
                />
              </div>
              <p className="font-serif font-bold text-xs-plus md:text-sm text-text-on-light">
                {t(weightKeyMap[row.weight] || row.weight)}
              </p>
              <p className="font-body font-semibold text-xs md:text-xs-plus mt-1" style={{ color: "#1a8a84" }}>
                {row.grams} {t("catalog:product.perDay")}
              </p>
              <p className="font-body text-[10px] md:text-xxs text-text-on-light/50 mt-0.5">
                {t(amountKeyMap[row.amount] || row.amount)}
              </p>
            </div>
          );
        })}
      </div>

      {isCat && (
        <div className="max-w-[560px] mx-auto mt-6 text-center">
          <p className="font-body text-xs text-text-on-light/60 leading-relaxed">
            {t("catalog:product.everyCatDifferent")}
          </p>
        </div>
      )}

      <div className="max-w-[560px] mx-auto mt-4 text-center">
        <p className="font-body text-xs text-text-on-light/65 leading-relaxed">
          {t(feedingNoteKey)}
        </p>
      </div>
    </div>
  );
};

export default FeedingGuideCompact;
