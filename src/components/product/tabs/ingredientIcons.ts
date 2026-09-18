// Konturowe ikony składników (SVG, kreska #2D2D2D, tło transparent) — dostarcza
// je wdrożenie przez `#deployment-media`, nie ten plik. Mapowanie po nazwie
// składnika z danych (PL nazwy psich receptur + EN aliasy legacy).
import {
  ingredientIconSheep as sheep,
  ingredientIconDeer as deer,
  ingredientIconCow as cow,
  ingredientIconTurkey as turkey,
  ingredientIconFish as fish,
  ingredientIconPig as pig,
  ingredientIconMushroom as mushroom,
  ingredientIconBroth as broth,
  ingredientIconBanana as banana,
  ingredientIconPumpkin as pumpkin,
  ingredientIconCarrot as carrot,
  ingredientIconBeet as beet,
  ingredientIconApple as apple,
  ingredientIconParsnip as parsnip,
  ingredientIconZucchini as zucchini,
  ingredientIconSweetPotato as sweetPotato,
  ingredientIconHeart as heart,
  ingredientIconYeast as yeast,
  ingredientIconOilDrop as oilDrop,
  ingredientIconPrebiotic as prebiotic,
  ingredientIconShield as shield,
} from "#deployment-media";

const byName: Record<string, string> = {
  "Jagnięcina": sheep,
  "Lamb": sheep,
  "Mięso z jelenia": deer,
  "Venison Meat": deer,
  "Wołowina": cow,
  "Indyk": turkey,
  "Łosoś": fish,
  "Salmon": fish,
  "Wieprzowina": pig,
  "EntoPro™": mushroom,
  "Banan": banana,
  "Dynia": pumpkin,
  "Pumpkin": pumpkin,
  "Pumpkin & Carrot": pumpkin,
  "Marchew": carrot,
  "Burak": beet,
  "Jabłko": apple,
  "Pasternak": parsnip,
  "Cukinia": zucchini,
  "Batat": sweetPotato,
  "Podroby z kurczaka": heart,
  "Offal: liver, heart, gizzards": heart,
  "Offal (liver, heart, gizzards)": heart,
  "Drożdże browarnicze": yeast,
  "Yeast": yeast,
  "Olej z łososia": oilDrop,
  "Salmon Oil": oilDrop,
  "MOS/FOS": prebiotic,
  "TruPet™ postbiotyk": shield,
  "TruPet™ Postbiotic": shield,
  "TruPet™ C": shield,
};

/** Ikona dla składnika: dopasowanie po nazwie, buliony po prefiksie. */
export function ingredientIcon(name: string): string | null {
  if (byName[name]) return byName[name];
  if (/^Bulion|Broth$|broth/.test(name)) return broth;
  return null;
}
