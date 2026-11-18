import { expect, it } from "vitest";
import { createPostgresCatalogPublication } from "../../src/catalog/publicationStore.js";
import { CATALOG_PUBLICATION_LIMITS, type CatalogPublicationReceiptV2 } from "../../src/catalog/contracts/publication.js";
import { canonicalCatalogDraftJson } from "../../src/catalog/contracts/draft.js";
import { catalogDraftPayloadV3Schema } from "../../src/catalog/draftV3Schemas.js";
import { validateCatalogDraft } from "../../src/catalog/draftValidation.js";
import { catalogDraftV3ValidationPayload } from "../../src/catalog/draftV3Schemas.js";
import { createCatalogProductTypeRegistry } from "../../src/catalog/productTypeSchemas.js";
import { catalogPublicationManifestSchema, catalogPublishedSkuSchema, catalogPublishedProductSchema, compileCatalogPublication, publicationDigest } from "../../src/catalog/publicationValidation.js";
import { input, registry, rules } from "./fixtures/publicationInput.js";

// Conservative aliases cover shared target grammar/identity predicates. Each
// executes the closed-contract matrix, rather than asserting a source-code token.
const witnesses = [
  "W03_V5-0007_predicate_precedence_boundary",
  "W03_V5-0008_predicate_precedence_boundary",
  "W03_V5-0009_predicate_precedence_boundary",
  "W03_V5-0010_predicate_precedence_boundary",
  "W03_V5-0011_predicate_precedence_boundary",
  "W03_V5-0012_predicate_precedence_boundary",
  "W03_V5-0013_predicate_precedence_boundary",
  "W03_V5-0014_predicate_precedence_boundary",
  "W03_V5-0015_predicate_precedence_boundary",
  "W03_V5-0016_predicate_precedence_boundary",
  "W03_V5-0017_predicate_precedence_boundary",
  "W03_V5-0018_predicate_precedence_boundary",
  "W03_V5-0019_predicate_precedence_boundary",
  "W03_V5-0020_predicate_precedence_boundary",
  "W03_V5-0021_predicate_precedence_boundary",
  "W03_V5-0022_predicate_precedence_boundary",
  "W03_V5-0023_predicate_precedence_boundary",
  "W03_V5-0024_predicate_precedence_boundary",
  "W03_V5-0025_predicate_precedence_boundary",
  "W03_V5-0026_predicate_precedence_boundary",
  "W03_V5-0027_predicate_precedence_boundary",
  "W37_V5-0062_predicate_precedence_boundary",
  "W37_V5-0063_predicate_precedence_boundary",
  "W37_V5-0064_predicate_precedence_boundary",
  "W37_V5-0084_predicate_precedence_boundary",
  "W37_V5-0085_predicate_precedence_boundary",
  "W37_V5-0086_predicate_precedence_boundary",
  "W37_V5-0087_predicate_precedence_boundary",
  "W37_V5-0088_predicate_precedence_boundary",
  "W37_V5-0089_predicate_precedence_boundary",
  "W37_V5-0090_predicate_precedence_boundary",
  "W37_V5-0091_predicate_precedence_boundary",
  "W37_V5-0092_predicate_precedence_boundary",
  "W37_V5-0093_predicate_precedence_boundary",
  "W37_V5-0094_predicate_precedence_boundary",
  "W37_V5-0095_predicate_precedence_boundary",
  "W37_V5-0096_predicate_precedence_boundary",
  "W37_V5-0097_predicate_precedence_boundary",
  "W37_V5-0098_predicate_precedence_boundary",
  "W37_V5-0099_predicate_precedence_boundary",
  "W37_V5-0100_predicate_precedence_boundary",
  "W37_V5-0101_predicate_precedence_boundary",
  "W37_V5-0102_predicate_precedence_boundary",
  "W37_V5-0103_predicate_precedence_boundary",
  "W37_V5-0104_predicate_precedence_boundary",
  "W37_V5-0105_predicate_precedence_boundary",
  "W37_V5-0106_predicate_precedence_boundary",
  "W37_V5-0107_predicate_precedence_boundary",
  "W37_V5-0108_predicate_precedence_boundary",
  "W37_V5-0109_predicate_precedence_boundary",
  "W37_V5-0110_predicate_precedence_boundary",
  "W37_V5-0111_predicate_precedence_boundary",
  "W37_V5-0112_predicate_precedence_boundary",
  "W37_V5-0113_predicate_precedence_boundary",
  "W37_V5-0114_predicate_precedence_boundary",
  "W37_V5-0115_predicate_precedence_boundary",
  "W37_V5-0116_predicate_precedence_boundary",
  "W37_V5-0117_predicate_precedence_boundary",
  "W37_V5-0118_predicate_precedence_boundary",
  "W37_V5-0119_predicate_precedence_boundary",
  "W37_V5-0120_predicate_precedence_boundary",
  "W37_V5-0307_predicate_precedence_boundary",
  "W37_V5-0308_predicate_precedence_boundary",
  "W37_V5-0309_predicate_precedence_boundary",
  "W37_V5-0310_predicate_precedence_boundary",
  "W37_V5-0311_predicate_precedence_boundary",
  "W37_V5-0312_predicate_precedence_boundary",
  "W37_V5-0320_predicate_precedence_boundary",
  "W37_V5-0321_predicate_precedence_boundary",
  "W37_V5-0322_predicate_precedence_boundary",
  "W37_V5-0323_predicate_precedence_boundary",
  "W37_V5-0324_predicate_precedence_boundary",
  "W37_V5-0325_predicate_precedence_boundary",
  "W37_V5-0326_predicate_precedence_boundary",
  "W37_V5-0327_predicate_precedence_boundary",
  "W37_V5-0328_predicate_precedence_boundary",
  "W37_V5-0329_predicate_precedence_boundary",
  "W37_V5-0330_predicate_precedence_boundary",
  "W37_V5-0331_predicate_precedence_boundary",
  "W37_V5-0417_predicate_precedence_boundary",
  "W37_V5-0418_predicate_precedence_boundary",
  "W37_V5-0419_predicate_precedence_boundary",
  "W37_V5-0420_predicate_precedence_boundary",
  "W37_V5-0424_predicate_precedence_boundary",
  "W37_V5-0425_predicate_precedence_boundary",
  "W37_V5-0426_predicate_precedence_boundary",
  "W37_V5-0427_predicate_precedence_boundary",
  "W37_V5-0428_predicate_precedence_boundary",
  "W37_V5-0429_predicate_precedence_boundary",
  "W37_V5-0430_predicate_precedence_boundary",
  "W37_V5-0431_predicate_precedence_boundary",
  "W37_V5-0432_predicate_precedence_boundary",
  "W37_V5-0433_predicate_precedence_boundary",
  "W37_V5-0434_predicate_precedence_boundary",
  "W35_V5-0435_predicate_precedence_boundary",
  "W35_V5-0436_predicate_precedence_boundary",
  "W35_V5-0437_predicate_precedence_boundary",
  "W35_V5-0438_predicate_precedence_boundary",
  "W35_V5-0439_predicate_precedence_boundary",
  "W35_V5-0440_predicate_precedence_boundary",
  "W35_V5-0441_predicate_precedence_boundary",
  "W35_V5-0442_predicate_precedence_boundary",
  "W35_V5-0443_predicate_precedence_boundary",
  "W35_V5-0444_predicate_precedence_boundary",
  "W35_V5-0445_predicate_precedence_boundary",
  "W35_V5-0446_predicate_precedence_boundary",
  "W35_V5-0447_predicate_precedence_boundary",
  "W35_V5-0448_predicate_precedence_boundary",
  "W35_V5-0456_predicate_precedence_boundary",
  "W35_V5-0457_predicate_precedence_boundary",
  "W35_V5-0458_predicate_precedence_boundary",
  "W35_V5-0459_predicate_precedence_boundary",
  "W35_V5-0460_predicate_precedence_boundary",
  "W35_V5-0461_predicate_precedence_boundary",
  "W35_V5-0462_predicate_precedence_boundary",
  "W35_V5-0463_predicate_precedence_boundary",
  "W35_V5-0464_predicate_precedence_boundary",
  "W35_V5-0465_predicate_precedence_boundary",
  "W35_V5-0466_predicate_precedence_boundary",
  "W35_V5-0467_predicate_precedence_boundary",
  "W35_V5-0468_predicate_precedence_boundary",
  "W35_V5-0469_predicate_precedence_boundary",
  "W35_V5-0471_predicate_precedence_boundary",
  "W35_V5-0474_predicate_precedence_boundary",
  "W35_V5-0476_predicate_precedence_boundary",
  "W35_V5-0477_predicate_precedence_boundary",
  "W35_V5-0478_predicate_precedence_boundary",
  "W35_V5-0479_predicate_precedence_boundary",
  "W35_V5-0480_predicate_precedence_boundary",
  "W35_V5-0481_predicate_precedence_boundary",
  "W35_V5-0482_predicate_precedence_boundary",
  "W35_V5-0483_predicate_precedence_boundary",
  "W35_V5-0484_predicate_precedence_boundary",
  "W35_V5-0503_predicate_precedence_boundary",
  "W35_V5-0508_predicate_precedence_boundary",
  "W35_V5-0509_predicate_precedence_boundary",
  "W35_V5-0510_predicate_precedence_boundary",
  "W35_V5-0511_predicate_precedence_boundary",
  "W35_V5-0512_predicate_precedence_boundary",
  "W35_V5-0513_predicate_precedence_boundary",
  "W35_V5-0514_predicate_precedence_boundary",
  "W35_V5-0515_predicate_precedence_boundary",
  "W35_V5-0516_predicate_precedence_boundary",
  "W35_V5-0517_predicate_precedence_boundary",
  "W35_V5-0518_predicate_precedence_boundary",
  "W34_V5-0531_predicate_precedence_boundary",
  "W34_V5-0532_predicate_precedence_boundary",
  "W34_V5-0533_predicate_precedence_boundary",
  "W34_V5-0534_predicate_precedence_boundary",
  "W34_V5-0535_predicate_precedence_boundary",
  "W34_V5-0536_predicate_precedence_boundary",
  "W34_V5-0537_predicate_precedence_boundary",
  "W34_V5-0538_predicate_precedence_boundary",
  "W34_V5-0540_predicate_precedence_boundary",
  "W34_V5-0541_predicate_precedence_boundary",
  "W34_V5-0542_predicate_precedence_boundary",
  "W34_V5-0543_predicate_precedence_boundary",
  "W34_V5-0556_predicate_precedence_boundary",
  "W34_V5-0557_predicate_precedence_boundary",
  "W34_V5-0558_predicate_precedence_boundary",
  "W34_V5-0559_predicate_precedence_boundary",
  "W34_V5-0560_predicate_precedence_boundary",
  "W34_V5-0561_predicate_precedence_boundary",
  "W34_V5-0562_predicate_precedence_boundary",
  "W34_V5-0563_predicate_precedence_boundary",
  "W34_V5-0564_predicate_precedence_boundary",
  "W34_V5-0618_predicate_precedence_boundary",
  "W34_V5-0633_predicate_precedence_boundary",
  "W34_V5-0634_predicate_precedence_boundary",
  "W34_V5-0635_predicate_precedence_boundary",
  "W34_V5-0636_predicate_precedence_boundary",
  "W34_V5-0641_predicate_precedence_boundary",
  "W34_V5-0651_predicate_precedence_boundary",
  "W34_V5-0652_predicate_precedence_boundary",
  "W34_V5-0653_predicate_precedence_boundary",
  "W34_V5-0654_predicate_precedence_boundary",
  "W34_V5-0655_predicate_precedence_boundary",
  "W34_V5-0656_predicate_precedence_boundary",
  "W34_V5-0657_predicate_precedence_boundary",
  "W34_V5-0658_predicate_precedence_boundary",
  "W34_V5-0659_predicate_precedence_boundary",
  "W34_V5-0661_predicate_precedence_boundary",
  "W34_V5-0662_predicate_precedence_boundary",
  "W34_V5-0663_predicate_precedence_boundary",
  "W34_V5-0664_predicate_precedence_boundary",
  "W34_V5-0665_predicate_precedence_boundary",
  "W34_V5-0666_predicate_precedence_boundary",
  "W34_V5-0667_predicate_precedence_boundary",
  "W34_V5-0668_predicate_precedence_boundary",
  "W37_V5-0670_predicate_precedence_boundary",
  "W07_V5-0681_predicate_precedence_boundary",
  "W07_V5-0682_predicate_precedence_boundary",
  "W07_V5-0683_predicate_precedence_boundary",
  "W07_V5-0684_predicate_precedence_boundary",
  "W07_V5-0685_predicate_precedence_boundary",
  "W07_V5-0686_predicate_precedence_boundary",
  "W07_V5-0687_predicate_precedence_boundary",
  "W07_V5-0688_predicate_precedence_boundary",
  "W07_V5-0689_predicate_precedence_boundary",
  "W07_V5-0690_predicate_precedence_boundary",
  "W07_V5-0691_predicate_precedence_boundary",
  "W07_V5-0692_predicate_precedence_boundary",
  "W34_V5-0693_predicate_precedence_boundary",
  "W34_V5-0694_predicate_precedence_boundary",
  "W34_V5-0695_predicate_precedence_boundary",
  "W34_V5-0696_predicate_precedence_boundary",
  "W34_V5-0697_predicate_precedence_boundary",
  "W34_V5-0699_predicate_precedence_boundary",
  "W12_V5-0709_predicate_precedence_boundary",
  "W12_V5-0710_predicate_precedence_boundary",
  "W12_V5-0711_predicate_precedence_boundary",
  "W37_V5-0712_predicate_precedence_boundary",
  "W37_V5-0713_predicate_precedence_boundary",
  "W37_V5-0714_predicate_precedence_boundary",
  "W37_V5-0715_predicate_precedence_boundary",
  "W37_V5-0716_predicate_precedence_boundary",
  "W44_V5-0757_predicate_precedence_boundary",
  "W44_V5-0758_predicate_precedence_boundary",
  "W08_V5-1454_predicate_precedence_boundary",
  "W08_V5-1455_predicate_precedence_boundary",
  "W08_V5-1456_predicate_precedence_boundary",
  "W08_V5-1457_predicate_precedence_boundary",
  "W08_V5-1458_predicate_precedence_boundary",
  "W08_V5-1459_predicate_precedence_boundary",
  "W08_V5-1460_predicate_precedence_boundary",
  "W08_V5-1461_predicate_precedence_boundary",
  "W08_V5-1462_predicate_precedence_boundary",
  "W08_V5-1463_predicate_precedence_boundary",
  "W08_V5-1464_predicate_precedence_boundary",
  "W08_V5-1465_predicate_precedence_boundary",
  "W08_V5-1466_predicate_precedence_boundary",
  "W08_V5-1467_predicate_precedence_boundary",
  "W08_V5-1468_predicate_precedence_boundary",
  "W08_V5-1469_predicate_precedence_boundary",
  "W08_V5-1470_predicate_precedence_boundary",
  "W08_V5-1471_predicate_precedence_boundary",
  "W08_V5-1472_predicate_precedence_boundary",
  "W08_V5-1473_predicate_precedence_boundary",
  "W08_V5-1474_predicate_precedence_boundary",
  "W08_V5-1475_predicate_precedence_boundary",
  "W08_V5-1476_predicate_precedence_boundary",
  "W08_V5-1477_predicate_precedence_boundary",
  "W08_V5-1478_predicate_precedence_boundary",
  "W44_V5-1683_predicate_precedence_boundary",
  "W44_V5-1684_predicate_precedence_boundary",
  "W44_V5-1685_predicate_precedence_boundary",
  "W44_V5-1686_predicate_precedence_boundary",
  "W44_V5-1687_predicate_precedence_boundary",
  "W44_V5-1688_predicate_precedence_boundary",
  "W44_V5-1689_predicate_precedence_boundary",
  "W08_V5-1737_predicate_precedence_boundary",
  "W08_V5-1738_predicate_precedence_boundary",
  "W08_V5-1739_predicate_precedence_boundary",
  "W08_V5-1740_predicate_precedence_boundary",
  "W08_V5-1741_predicate_precedence_boundary",
  "W08_V5-1742_predicate_precedence_boundary",
  "W08_V5-1743_predicate_precedence_boundary",
  "W08_V5-1744_predicate_precedence_boundary",
  "W08_V5-1745_predicate_precedence_boundary",
  "W08_V5-1746_predicate_precedence_boundary",
  "W08_V5-1747_predicate_precedence_boundary",
  "W08_V5-1748_predicate_precedence_boundary",
  "W08_V5-1749_predicate_precedence_boundary",
  "W08_V5-1750_predicate_precedence_boundary",
  "W08_V5-1751_predicate_precedence_boundary",
  "W08_V5-1752_predicate_precedence_boundary",
  "W08_V5-1753_predicate_precedence_boundary",
  "W08_V5-1754_predicate_precedence_boundary",
  "W08_V5-1755_predicate_precedence_boundary",
  "W08_V5-1756_predicate_precedence_boundary",
  "W08_V5-1757_predicate_precedence_boundary",
  "W08_V5-1758_predicate_precedence_boundary",
  "W08_V5-1759_predicate_precedence_boundary",
  "W08_V5-1760_predicate_precedence_boundary",
  "W08_V5-1761_predicate_precedence_boundary",
  "W08_V5-1762_predicate_precedence_boundary",
  "W08_V5-1763_predicate_precedence_boundary",
  "W08_V5-1764_predicate_precedence_boundary",
  "W08_V5-1765_predicate_precedence_boundary",
  "W08_V5-1766_predicate_precedence_boundary",
  "W08_V5-1767_predicate_precedence_boundary",
  "W08_V5-1768_predicate_precedence_boundary",
  "W08_V5-1769_predicate_precedence_boundary",
  "W08_V5-1770_predicate_precedence_boundary",
  "W08_V5-1771_predicate_precedence_boundary",
  "W08_V5-1772_predicate_precedence_boundary",
  "W08_V5-1773_predicate_precedence_boundary",
  "W08_V5-1774_predicate_precedence_boundary",
  "W08_V5-1775_predicate_precedence_boundary",
  "W08_V5-1776_predicate_precedence_boundary",
  "W08_V5-1777_predicate_precedence_boundary",
  "W08_V5-1778_predicate_precedence_boundary",
  "W08_V5-1779_predicate_precedence_boundary",
  "W39_V5-1790_predicate_precedence_boundary",
  "W39_V5-1791_predicate_precedence_boundary",
  "W39_V5-1792_predicate_precedence_boundary",
  "W03_V5-1798_predicate_precedence_boundary",
  "W03_V5-1799_predicate_precedence_boundary",
  "W03_V5-1800_predicate_precedence_boundary",
  "W03_V5-1801_predicate_precedence_boundary",
  "W03_V5-1802_predicate_precedence_boundary",
  "W03_V5-1803_predicate_precedence_boundary",
  "W07_V5-1843_predicate_precedence_boundary",
  "W07_V5-1844_predicate_precedence_boundary",
  "W07_V5-1845_predicate_precedence_boundary",
  "W07_V5-1846_predicate_precedence_boundary",
  "W07_V5-1847_predicate_precedence_boundary",
  "W07_V5-1848_predicate_precedence_boundary",
  "W07_V5-1849_predicate_precedence_boundary",
  "W07_V5-1850_predicate_precedence_boundary",
  "W39_V5-1861_predicate_precedence_boundary",
  "W39_V5-1862_predicate_precedence_boundary",
  "W39_V5-1863_predicate_precedence_boundary",
  "W39_V5-1864_predicate_precedence_boundary",
  "W39_V5-1865_predicate_precedence_boundary",
  "W39_V5-1866_predicate_precedence_boundary",
  "W39_V5-1867_predicate_precedence_boundary",
  "W39_V5-1868_predicate_precedence_boundary",
  "W11_V5-1869_predicate_precedence_boundary",
  "W11_V5-1870_predicate_precedence_boundary",
  "W11_V5-1871_predicate_precedence_boundary",
  "W11_V5-1875_predicate_precedence_boundary",
  "W11_V5-1876_predicate_precedence_boundary",
  "W11_V5-1877_predicate_precedence_boundary",
  "W11_V5-1878_predicate_precedence_boundary",
  "W11_V5-1879_predicate_precedence_boundary",
  "W11_V5-1880_predicate_precedence_boundary",
  "W11_V5-1882_predicate_precedence_boundary",
  "W11_V5-1883_predicate_precedence_boundary",
  "W07_V5-1885_predicate_precedence_boundary",
  "W07_V5-1886_predicate_precedence_boundary",
  "W07_V5-1887_predicate_precedence_boundary",
  "W07_V5-1888_predicate_precedence_boundary",
  "W07_V5-1889_predicate_precedence_boundary",
  "W07_V5-1890_predicate_precedence_boundary",
  "W07_V5-1891_predicate_precedence_boundary",
  "W07_V5-1892_predicate_precedence_boundary",
  "W07_V5-1893_predicate_precedence_boundary",
  "W07_V5-1894_predicate_precedence_boundary",
  "W11_V5-1896_predicate_precedence_boundary",
  "W11_V5-1897_predicate_precedence_boundary",
  "W12_V5-1899_predicate_precedence_boundary",
  "W12_V5-1900_predicate_precedence_boundary",
  "W11_V5-1902_predicate_precedence_boundary",
  "W11_V5-1903_predicate_precedence_boundary",
  "W11_V5-1907_predicate_precedence_boundary",
  "W11_V5-1908_predicate_precedence_boundary",
  "W11_V5-1910_predicate_precedence_boundary",
  "W11_V5-1911_predicate_precedence_boundary",
  "W11_V5-1913_predicate_precedence_boundary",
  "W11_V5-1914_predicate_precedence_boundary",
  "W11_V5-1916_predicate_precedence_boundary",
  "W11_V5-1917_predicate_precedence_boundary",
  "W11_V5-1919_predicate_precedence_boundary",
  "W11_V5-1920_predicate_precedence_boundary",
  "W11_V5-1921_predicate_precedence_boundary",
  "W11_V5-1923_predicate_precedence_boundary",
  "W11_V5-1924_predicate_precedence_boundary",
  "W11_V5-1926_predicate_precedence_boundary",
  "W11_V5-1927_predicate_precedence_boundary",
  "W11_V5-1928_predicate_precedence_boundary",
  "W11_V5-1929_predicate_precedence_boundary",
  "W13_V5-1932_predicate_precedence_boundary",
  "W13_V5-1933_predicate_precedence_boundary",
  "W14_V5-1935_predicate_precedence_boundary",
  "W14_V5-1936_predicate_precedence_boundary",
  "W14_V5-1937_predicate_precedence_boundary",
  "W14_V5-1938_predicate_precedence_boundary",
  "W14_V5-1939_predicate_precedence_boundary",
  "W14_V5-1940_predicate_precedence_boundary",
  "W14_V5-1941_predicate_precedence_boundary",
  "W14_V5-1942_predicate_precedence_boundary",
  "W14_V5-1943_predicate_precedence_boundary",
  "W14_V5-1944_predicate_precedence_boundary",
  "W14_V5-1945_predicate_precedence_boundary",
  "W14_V5-1946_predicate_precedence_boundary",
  "W14_V5-1947_predicate_precedence_boundary",
  "W14_V5-1948_predicate_precedence_boundary",
  "W14_V5-1949_predicate_precedence_boundary",
  "W14_V5-1950_predicate_precedence_boundary",
  "W10_V5-2019_predicate_precedence_boundary",
  "W10_V5-2020_predicate_precedence_boundary",
  "W10_V5-2021_predicate_precedence_boundary",
  "W10_V5-2022_predicate_precedence_boundary",
  "W10_V5-2023_predicate_precedence_boundary",
  "W10_V5-2024_predicate_precedence_boundary",
  "W10_V5-2025_predicate_precedence_boundary",
  "W10_V5-2026_predicate_precedence_boundary",
  "W10_V5-2027_predicate_precedence_boundary",
  "W10_V5-2028_predicate_precedence_boundary",
  "W10_V5-2029_predicate_precedence_boundary",
  "W10_V5-2030_predicate_precedence_boundary",
  "W10_V5-2031_predicate_precedence_boundary",
  "W10_V5-2032_predicate_precedence_boundary",
  "W10_V5-2033_predicate_precedence_boundary",
  "W10_V5-2034_predicate_precedence_boundary",
  "W10_V5-2035_predicate_precedence_boundary",
  "W10_V5-2036_predicate_precedence_boundary",
  "W10_V5-2037_predicate_precedence_boundary",
  "W10_V5-2038_predicate_precedence_boundary",
  "W10_V5-2039_predicate_precedence_boundary",
  "W10_V5-2040_predicate_precedence_boundary",
  "W10_V5-2041_predicate_precedence_boundary",
  "W10_V5-2042_predicate_precedence_boundary",
  "W10_V5-2043_predicate_precedence_boundary",
  "W12_V5-2102_predicate_precedence_boundary",
  "W12_V5-2103_predicate_precedence_boundary",
  "W12_V5-2104_predicate_precedence_boundary",
  "W12_V5-2105_predicate_precedence_boundary",
  "W12_V5-2109_predicate_precedence_boundary",
  "W12_V5-2110_predicate_precedence_boundary"
] as const;
it.each(witnesses)("%s", () => {
  const data = input(), base = data.payload;
  base.product.sharedContent.offerMemberships = [{ skuCode: "ARTICLE", offerVersion: "example:offer", admitted: false }];
  base.publication.operations.push({ op: "set_offer_membership", ...base.product.sharedContent.offerMemberships[0] });
  expect(catalogDraftPayloadV3Schema.safeParse(base).success).toBe(true);
  for (const version of [0, 1, 2, 4, "3", null]) expect(catalogDraftPayloadV3Schema.safeParse({ ...base, schemaVersion: version }).success).toBe(false);
  for (const value of [null, [], { ...base, extra: true }, { ...base, product: { ...base.product, id: "not-an-id" } },
    { ...base, skus: [{ ...base.skus[0], productId: "10000000-0000-4000-8000-000000000002" }] },
    { ...base, product: { ...base.product, primarySkuId: "20000000-0000-4000-8000-000000000002" } },
    { ...base, product: { ...base.product, id: "ABCDEFAB-CDEF-4ABC-8DEF-ABCDEFABCDEF" } },
    { ...base, publication: { ...base.publication, kind: "adopt_v1" } },
  ]) expect(catalogDraftPayloadV3Schema.safeParse(value).success).toBe(false);
  const extraOperations = [
    { op: "set_eligibility", skuCode: "ARTICLE", sellableStandalone: true, sellableInSubscription: false },
    { op: "set_sku_status", skuCode: "ARTICLE", status: "active" },
    { op: "set_product_status", productSlug: "article", status: "active" },
    { op: "set_offer_membership", skuCode: "ARTICLE", offerVersion: "example:offer", admitted: false },
    { op: "set_sku_metadata", skuCode: "ARTICLE", logisticsRef: null },
    { op: "set_derived_sku_facts", skuCode: "ARTICLE", documentRevisionNo: 1, netContent: base.skus[0].netContent, facts: { derived: 12 } },
  ];
  const complete = { ...base, publication: { ...base.publication, operations: [...base.publication.operations, ...extraOperations] } };
  expect(catalogDraftPayloadV3Schema.safeParse(complete).success).toBe(true);
  for (let index = 0; index < complete.publication.operations.length; index++) {
    const operation = complete.publication.operations[index];
    for (const changed of [{ ...operation, extra: true }, { ...operation, op: "unknown" },
      ...Object.keys(operation).map(key => ({ ...operation, [key]: [] }))]) {
      const operations = [...complete.publication.operations]; operations[index] = changed as typeof operation;
      expect(catalogDraftPayloadV3Schema.safeParse({ ...complete, publication: { ...complete.publication, operations } }).success).toBe(false);
    }
  }
  const operations = base.publication.operations;
  for (const invalid of [operations.filter(operation => operation.op !== "create_sku"),
    [operations[4], ...operations.filter((_, index) => index !== 4)], [...operations, operations[0]], [...operations, operations[1]],
    [...operations, operations[4]], [...operations, { op: "set_sku_status", skuCode: "ARTICLE", status: "active" }]])
    expect(catalogDraftPayloadV3Schema.safeParse({ ...base, publication: { ...base.publication, operations: invalid } }).success).toBe(false);
  for (const key of ["offerMemberships", "requestedModes", "publicationSkus"] as const) {
    if (!base.product.sharedContent[key].length) continue;
    expect(catalogDraftPayloadV3Schema.safeParse({ ...base, product: { ...base.product, sharedContent: { ...base.product.sharedContent,
      [key]: [...base.product.sharedContent[key], ...base.product.sharedContent[key]] } } }).success).toBe(false);
  }
  const draft = { draftId: data.record.draftId, revision: 1, commandKey: "draft:first", fingerprint: "b".repeat(64) };
  const media = { skuCode: "ARTICLE", mediaRef: "example:media", revisionDigest: "c".repeat(64), assetRefs: ["a", "b"] };
  for (const evidence of [{ drafts: [draft, draft] }, { media: [media, media] }, { media: [{ ...media, assetRefs: ["b", "a"] }] },
    { media: [{ ...media, assetRefs: ["a", "a"] }] }, { media: [{ ...media, revisionDigest: "bad" }] }, { unknown: true }])
    expect(catalogDraftPayloadV3Schema.safeParse({ ...base, publication: { ...base.publication, evidence } }).success).toBe(false);
  const compiled = compileCatalogPublication(data), reference = { skuId: compiled.skus[0].id, revisionId: "50000000-0000-4000-8000-000000000001", revision: 1, digest: publicationDigest(compiled.skus[0]) };
  const manifest = { schemaVersion: 2, product: compiled.product, skus: [reference] };
  expect(catalogPublicationManifestSchema.safeParse(manifest).success).toBe(true);
  for (const value of [{ ...manifest, extra: true }, { ...manifest, schemaVersion: 3 }, { ...manifest, skus: [] },
    { ...manifest, skus: [reference, reference] }, { ...manifest, skus: [{ ...reference, revision: 0 }] }, { ...manifest, skus: [{ ...reference, digest: "bad" }] }])
    expect(catalogPublicationManifestSchema.safeParse(value).success).toBe(false);
  for (const value of [{ ...compiled.skus[0], extra: true }, { ...compiled.skus[0], productId: "bad" }, { ...compiled.skus[0], status: "withdrawn" },
    { ...compiled.skus[0], attributes: { invalid: 42 } }, { ...compiled.skus[0], minQuantity: 0 }]) expect(catalogPublishedSkuSchema.safeParse(value).success).toBe(false);
  expect(publicationDigest({ ...manifest, schemaVersion: 3 })).not.toBe(publicationDigest(manifest));
  expect(() => canonicalCatalogDraftJson({ unsafe: undefined })).toThrow();
  const cycle: Record<string, unknown> = {}; cycle.self = cycle;
  expect(() => canonicalCatalogDraftJson(cycle)).toThrow();
  const v2 = { ...catalogDraftV3ValidationPayload(base), schemaVersion: 1 as const };
  for (const value of [
    { ...v2, product: { ...v2.product, type: { key: "example:missing", version: 1 } } },
    { ...v2, skus: [...v2.skus, ...v2.skus] },
    { ...v2, skus: [{ ...v2.skus[0], netContent: { dimension: "mass", unit: "example:missing", unscaled: "1", scale: 0 } }] },
  ]) expect(validateCatalogDraft(value as typeof v2, registry).valid).toBe(false);
  expect(() => createCatalogProductTypeRegistry([{ ...data.definition, version: 0 }])).toThrow();
  expect(() => createCatalogProductTypeRegistry([data.definition, data.definition])).toThrow();
});

it("cycle1 retained fact scalar and roster boundaries", () => {
  const compiled = compileCatalogPublication(input());
  function skuPatch(change: (sku: typeof compiled.skus[number]) => void, accepts: boolean) {
    const sku = structuredClone(compiled.skus[0]); change(sku);
    expect(catalogPublishedSkuSchema.safeParse(sku).success).toBe(accepts);
  }
  function productPatch(change: (product: typeof compiled.product) => void, accepts: boolean) {
    const product = structuredClone(compiled.product); change(product);
    expect(catalogPublishedProductSchema.safeParse(product).success).toBe(accepts);
  }
  for (const [field, maximum] of [["code",160],["title",500],["logisticsRef",500]] as const)
    for (const length of [0,1,maximum-1,maximum,maximum+1]) skuPatch(sku => { sku[field] = "a".repeat(length); }, length>=1 && length<=maximum);
  for (const value of [0,1,2,2_147_483_646,2_147_483_647,2_147_483_648,1.5]) {
    const accepts = Number.isInteger(value) && value>=1 && value<=2_147_483_647;
    skuPatch(sku => { sku.minQuantity=value; },accepts);
    skuPatch(sku => { sku.source.revision=value; },accepts);
    productPatch(product => { product.source.revision=value; },accepts);
  }
  for (const field of ["commandKey"] as const) for(const length of [0,1,239,240,241]) {
    skuPatch(sku => {sku.source[field]="a".repeat(length);},length>=1&&length<=240);
    productPatch(product => {product.source[field]="a".repeat(length);},length>=1&&length<=240);
  }
  for(const [field,maximum] of [["name",500],["slug",null]] as const) for(const length of [0,1,499,500,501])
    productPatch(product=>{product[field]="a".repeat(length);},length>=1&&(maximum===null||length<=maximum));
  for(const count of [0,1,15,16,17]) productPatch(product=>{product.axes=Array.from({length:count},(_,i)=>`axis${i}`);},count<=16);
  productPatch(product=>{product.axes=["axis","axis"];},false);
  for(const count of [0,1,31,32,33]) skuPatch(sku=>{sku.assetRefs=Array.from({length:count},(_,i)=>`example:asset-${i}`);},count<=32);
  for(const [field,maximum] of [["scheme",240],["issuer",240],["value",128],["label",500],["sourceRef",240]] as const)
    for(const length of [0,1,maximum-1,maximum,maximum+1]) skuPatch(sku=>{
      const identifier=sku.identifiers[0];identifier.scheme="example:identifier";identifier.isPrimary=false;identifier[field]="a".repeat(length);
    },length>=1&&length<=maximum);
  for(const value of [0,1,2,999_998,999_999,1_000_000,2.5]) skuPatch(sku=>{
    sku.identifiers[0].packagingLevel="case";sku.identifiers[0].isPrimary=false;sku.identifiers[0].quantity=value;
  },Number.isInteger(value)&&value>=2&&value<=999_999);
  for(const value of [0,1,2]) skuPatch(sku=>{sku.identifiers[0].quantity=value;},value===1);
  skuPatch(sku=>{sku.memberships=[{offerVersion:"a",admitted:false},{offerVersion:"b",admitted:true}];},true);
  skuPatch(sku=>{sku.memberships=[{offerVersion:"b",admitted:false},{offerVersion:"a",admitted:true}];},false);
  skuPatch(sku=>{sku.memberships=[{offerVersion:"a",admitted:false},{offerVersion:"a",admitted:true}];},false);
  skuPatch(sku=>{sku.identifiers.push({...sku.identifiers[0],value:"4006381333931"});},false);
  for(const field of ["logisticsRef"] as const) for(const value of [" a","a ","\ta","a\n"]) skuPatch(sku=>{sku[field]=value;},false);
  const ref={skuId:compiled.skus[0].id,revisionId:"50000000-0000-4000-8000-000000000001",revision:1,digest:"a".repeat(64)};
  for(const revision of [0,1,2_147_483_647,2_147_483_648]) expect(catalogPublicationManifestSchema.safeParse({schemaVersion:2,product:compiled.product,skus:[{...ref,revision}]}).success).toBe(revision>=1&&revision<=2_147_483_647);
  for(const skus of [[],[ref,ref],[{...ref,skuId:"20000000-0000-4000-8000-000000000002"},ref]])
    expect(catalogPublicationManifestSchema.safeParse({schemaVersion:2,product:compiled.product,skus}).success).toBe(false);
});

it("cycle1 publication envelope exact UTF-8 boundary", () => {
  const value = { text: "é" }, text = canonicalCatalogDraftJson(value), bytes = Buffer.byteLength(text);
  expect(() => publicationDigest(value, bytes - 1)).toThrow("catalog_publication_envelope_too_large");
  expect(publicationDigest(value, bytes)).toBe(publicationDigest(value, bytes + 1));
});

it("cycle1 primary identifier keeps independent scheme and packaging guards", () => {
  const sku = compileCatalogPublication(input()).skus[0];
  expect(catalogPublishedSkuSchema.safeParse(sku).success).toBe(true);
  const foreignScheme = structuredClone(sku); foreignScheme.identifiers[0].scheme = "example:identifier";
  expect(catalogPublishedSkuSchema.safeParse(foreignScheme).success).toBe(false);
  const primaryCase = structuredClone(sku); primaryCase.identifiers[0].packagingLevel = "case"; primaryCase.identifiers[0].quantity = 2;
  expect(catalogPublishedSkuSchema.safeParse(primaryCase).success).toBe(false);
});

it.each(["W39_V5-1794_predicate_precedence_boundary", "terminal history uses its exact null-cursor envelope"] as const)("%s", async mode => {
  const { payload, record } = input();
  const productId = payload.product.id;
  const actorId = "70000000-0000-4000-8000-000000000001";
  const documentDigest = payload.product.documentRevision!.digest;
  const suffix = (value: number) => String(value).padStart(12, "0");
  const headAt = (revision: number) => ({
    publicationId: `50000000-0000-4000-8000-${suffix(revision)}`, revision, documentDigest,
  });
  const history = Array.from({ length: 20 }, (_, index) => {
    const revision = 20 - index;
    const head = headAt(revision), previousHead = revision > 1 ? headAt(revision - 1) : null;
    const receipt: CatalogPublicationReceiptV2 = {
      schemaVersion: 2, productId, commandKey: `publish:${revision}`, fingerprint: "a".repeat(64), actorId,
      head, previousHead, publicationDigest: "b".repeat(64), committedAt: "2026-01-01T00:00:00.000000Z",
      changes: Array.from({ length: 2500 }, (_, index) => {
        const variantId = `60000000-0000-4000-8000-${suffix(index + 1)}`;
        return { productId, variantId, sku: `SKU-${suffix(index + 1)}`, state: "active", variantRevision: revision,
          publicationHead: head, draftRef: { draftId: record.draftId, revision } };
      }),
    };
    return { revision, id: head.publicationId, result: receipt, kind: "publish", scope_id: productId,
      command_key: receipt.commandKey, fingerprint: receipt.fingerprint, actor_id: actorId, publication_id: head.publicationId };
  });
  const terminal = mode.startsWith("terminal");
  if (terminal) {
    history.splice(16);
    const legacy = history.map(row => {
      const { schemaVersion: _version, productId: _product, publicationDigest: _digest, committedAt: _at, ...receipt } = row.result;
      return receipt;
    });
    const size = Buffer.byteLength(JSON.stringify({ outcome: "page", receipts: legacy, limit: 100, nextCursor: null }));
    const text = CATALOG_PUBLICATION_LIMITS.historyBytes - size;
    history.at(-1)!.result.changes.at(-1)!.sku += "é".repeat(Math.floor(text / 2)) + "x".repeat(text % 2);
  }
  const historyQueries: unknown[][] = [];
  const target = createPostgresCatalogPublication({
    registry, rules, authorizeHuman: async () => ({ ok: false }),
    transactions: { run: work => work({ async query(sql, params) {
      if (sql.startsWith("SET TRANSACTION")) return { rows: [] };
      if (sql.startsWith("SELECT EXISTS")) return { rows: [{ unknown: false }] };
      if (sql.startsWith("SELECT p.revision,p.id,r.result")) {
        const [scope, highWater, before] = params!;
        historyQueries.push(params!);
        return { rows: history.filter(row => row.scope_id === scope &&
          (highWater === null || row.revision <= Number(highWater)) && (before === null || row.revision < Number(before))) };
      }
      if (sql.startsWith("SELECT p.revision,p.digest,d.digest")) {
        const stored = history.find(row => row.id === params?.[0] && row.scope_id === params?.[1]);
        if (!stored) throw new Error("Unknown history receipt");
        const { result } = stored;
        return { rows: [{ revision: result.head.revision, digest: result.publicationDigest, document_digest: documentDigest,
          previous_id: result.previousHead?.publicationId ?? null, previous_revision: result.previousHead?.revision ?? null,
          previous_document_digest: result.previousHead?.documentDigest ?? null, committed_at: result.committedAt,
          command_key: result.commandKey, actor_id: result.actorId, receipt_count: 1, recorded_changes: result.changes }] };
      }
      throw new Error("Unexpected history query");
    } }) },
    readiness: async () => { throw new Error("Unexpected readiness call"); },
    verifyMedia: async () => { throw new Error("Unexpected media call"); },
  });

  const first = await target.reads.history(productId, null);
  expect(first.outcome).toBe("page");
  if (first.outcome !== "page") throw new Error("Missing history page");
  if (terminal) {
    expect(first.receipts).toHaveLength(16);
    expect(first.nextCursor).toBeNull();
    expect(Buffer.byteLength(JSON.stringify(first))).toBe(CATALOG_PUBLICATION_LIMITS.historyBytes);
    return;
  }
  if (first.nextCursor === null) throw new Error("Missing history continuation");
  expect(first.receipts.map(receipt => receipt.head.revision)).toEqual([20, 19, 18, 17, 16, 15, 14, 13, 12, 11, 10, 9, 8, 7, 6, 5]);
  expect(JSON.parse(Buffer.from(first.nextCursor, "base64url").toString("utf8"))).toEqual({
    schemaVersion: 1, kind: "history", productId, highWater: 20, before: 5,
  });
  const rest = await target.reads.history(productId, first.nextCursor);
  expect(rest.outcome).toBe("page");
  if (rest.outcome !== "page") throw new Error("Missing history remainder");
  expect(rest.receipts.map(receipt => receipt.head.revision)).toEqual([4, 3, 2, 1]);
  expect(rest.nextCursor).toBeNull();
  expect(historyQueries).toEqual([[productId, null, null], [productId, 20, 5]]);

  const bytes = Buffer.byteLength(JSON.stringify(first));
  expect(bytes).toBeLessThanOrEqual(CATALOG_PUBLICATION_LIMITS.historyBytes);
  expect(bytes + Buffer.byteLength(JSON.stringify(rest.receipts[0])) + 1).toBeGreaterThan(CATALOG_PUBLICATION_LIMITS.historyBytes);
});
