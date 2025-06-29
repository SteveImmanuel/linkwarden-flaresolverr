import {
  Browser,
  BrowserContext,
  BrowserContextOptions,
  LaunchOptions,
  chromium,
  devices,
} from "playwright";
import axios from 'axios';
import { prisma } from "@linkwarden/prisma";
import sendToWayback from "./preservationScheme/sendToWayback";
import { AiTaggingMethod } from "@linkwarden/prisma/client";
import fetchHeaders from "./fetchHeaders";
import { createFolder, removeFiles } from "@linkwarden/filesystem";
import handleMonolith from "./preservationScheme/handleMonolith";
import handleReadability from "./preservationScheme/handleReadability";
import handleArchivePreview from "./preservationScheme/handleArchivePreview";
import handleScreenshotAndPdf from "./preservationScheme/handleScreenshotAndPdf";
import imageHandler from "./preservationScheme/imageHandler";
import pdfHandler from "./preservationScheme/pdfHandler";
import autoTagLink from "./autoTagLink";
import { LinkWithCollectionOwnerAndTags } from "@linkwarden/types";
import { isArchivalTag } from "@linkwarden/lib";
import { ArchivalSettings } from "@linkwarden/types";

const BROWSER_TIMEOUT = Number(process.env.BROWSER_TIMEOUT) || 5;

export default async function archiveHandler(
  link: LinkWithCollectionOwnerAndTags
) {
  const user = link.collection?.owner;

  if (
    process.env.DISABLE_PRESERVATION === "true" ||
    (!link.url?.startsWith("http://") && !link.url?.startsWith("https://"))
  ) {
    await prisma.link.update({
      where: { id: link.id },
      data: {
        lastPreserved: new Date().toISOString(),
        readable: "unavailable",
        image: "unavailable",
        monolith: "unavailable",
        pdf: "unavailable",
        preview: "unavailable",

        // To prevent re-archiving the same link
        aiTagged:
          user.aiTaggingMethod !== AiTaggingMethod.DISABLED &&
            !link.aiTagged &&
            (process.env.NEXT_PUBLIC_OLLAMA_ENDPOINT_URL ||
              process.env.OPENAI_API_KEY ||
              process.env.AZURE_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.OPENROUTER_API_KEY)
            ? true
            : undefined,
      },
    });

    return;
  }

  const abortController = new AbortController();

  const timeoutPromise = new Promise((_, reject) => {
    setTimeout(() => {
      abortController.abort();

      return reject(
        new Error(
          `Browser has been open for more than ${BROWSER_TIMEOUT} minutes.`
        )
      );
    }, BROWSER_TIMEOUT * 60000);
  });

  const { browser, context } = await getBrowser();

  const captchaSolve = await solveCaptcha(link.url);

  if (captchaSolve.status === 'error') {
    console.error('Error solving captcha');
  } else if (captchaSolve.status === 'fail') {
    console.warn('Failed solving captcha');
  } else if (captchaSolve.status === 'skip') {
    console.info('Skip solving captcha');
  } else {
    if (captchaSolve.solution) {
      console.info('Solving captcha');
      await context.addCookies(captchaSolve.solution.cookies);
    }
  }

  const page = await context.newPage();

  createFolder({ filePath: `archives/preview/${link.collectionId}` });
  createFolder({ filePath: `archives/${link.collectionId}` });

  const archivalTags = link.tags.filter(isArchivalTag);

  const archivalSettings: ArchivalSettings =
    archivalTags.length > 0
      ? {
        archiveAsScreenshot: archivalTags.some(
          (tag) => tag.archiveAsScreenshot
        ),
        archiveAsMonolith: archivalTags.some((tag) => tag.archiveAsMonolith),
        archiveAsPDF: archivalTags.some((tag) => tag.archiveAsPDF),
        archiveAsReadable: archivalTags.some((tag) => tag.archiveAsReadable),
        archiveAsWaybackMachine: archivalTags.some(
          (tag) => tag.archiveAsWaybackMachine
        ),
        aiTag: archivalTags.some((tag) => tag.aiTag),
      }
      : {
        archiveAsScreenshot: user.archiveAsScreenshot,
        archiveAsMonolith: user.archiveAsMonolith,
        archiveAsPDF: user.archiveAsPDF,
        archiveAsReadable: user.archiveAsReadable,
        archiveAsWaybackMachine: user.archiveAsWaybackMachine,
        aiTag: user.aiTaggingMethod !== AiTaggingMethod.DISABLED,
      };

  let newLinkName = '';
  try {
    await Promise.race([
      (async () => {
        const { linkType, imageExtension } = await determineLinkType(
          link.id,
          link.url
        );

        // send to archive.org
        if (archivalSettings.archiveAsWaybackMachine && link.url)
          sendToWayback(link.url);

        if (linkType === "image" && !link.image) {
          await imageHandler(link, imageExtension); // archive image (jpeg/png)
          return;
        } else if (linkType === "pdf" && !link.pdf) {
          await pdfHandler(link); // archive pdf
          return;
        } else if (link.url) {
          // archive url

          await page.goto(link.url, { waitUntil: "domcontentloaded" });
          newLinkName = await page.title();

          const metaDescription = await page.evaluate(() => {
            const description = document.querySelector(
              'meta[name="description"]'
            );
            return description?.getAttribute("content") ?? undefined;
          });

          const content = await page.content();

          // Preview
          if (!link.preview) await handleArchivePreview(link, page);

          // Readability
          if (archivalSettings.archiveAsReadable && !link.readable)
            await handleReadability(content, link);

          // Screenshot/PDF
          if (
            (archivalSettings.archiveAsScreenshot && !link.image) ||
            (archivalSettings.archiveAsPDF && !link.pdf)
          )
            await handleScreenshotAndPdf(link, page, archivalSettings);

          await browser.close();

          // Auto-tagging
          if (
            archivalSettings.aiTag &&
            user.aiTaggingMethod !== AiTaggingMethod.DISABLED &&
            !link.aiTagged &&
            (process.env.NEXT_PUBLIC_OLLAMA_ENDPOINT_URL ||
              process.env.OPENAI_API_KEY ||
              process.env.AZURE_API_KEY ||
              process.env.ANTHROPIC_API_KEY ||
              process.env.OPENROUTER_API_KEY)
          )
            await autoTagLink(user, link.id, metaDescription);

          // Monolith
          if (archivalSettings.archiveAsMonolith && !link.monolith && link.url)
            await handleMonolith(link, content, abortController.signal).catch(
              (err) => {
                console.error(err);
              }
            );
        }
      })(),
      timeoutPromise,
    ]);
  } catch (err) {
    console.log("Failed Link:", link.url);
    console.log("Reason:", err);
    throw err;
  } finally {
    const finalLink = await prisma.link.findUnique({
      where: { id: link.id },
    });

    if (finalLink) {
      // Replace the captcha-blocked link name if it has not been updated by user, else keep the same name
      if (newLinkName === '' || finalLink.name === newLinkName || finalLink.name !== 'Just a moment...') {
        newLinkName = finalLink.name;
      }

      await prisma.link.update({
        where: { id: link.id },
        data: {
          name: newLinkName,
          lastPreserved: new Date().toISOString(),
          readable: !finalLink.readable ? "unavailable" : undefined,
          image: !finalLink.image ? "unavailable" : undefined,
          monolith: !finalLink.monolith ? "unavailable" : undefined,
          pdf: !finalLink.pdf ? "unavailable" : undefined,
          preview: !finalLink.preview ? "unavailable" : undefined,
          aiTagged:
            user.aiTaggingMethod !== AiTaggingMethod.DISABLED &&
              !finalLink.aiTagged
              ? true
              : undefined,
        },
      });
    }
    else {
      await removeFiles(link.id, link.collectionId);
    }

    if (browser && browser.isConnected()) {
      await browser.close();
    }
  }
}

// Determine the type of the link based on its content-type header.
async function determineLinkType(
  linkId: number,
  url?: string | null
): Promise<{
  linkType: "url" | "pdf" | "image";
  imageExtension: "png" | "jpeg";
}> {
  let linkType: "url" | "pdf" | "image" = "url";
  let imageExtension: "png" | "jpeg" = "png";

  if (!url) return { linkType: "url", imageExtension };

  const headers = await fetchHeaders(url);
  const contentType = headers?.get("content-type");

  if (contentType?.includes("application/pdf")) {
    linkType = "pdf";
  } else if (contentType?.startsWith("image")) {
    linkType = "image";
    if (contentType.includes("image/jpeg")) imageExtension = "jpeg";
    else if (contentType.includes("image/png")) imageExtension = "png";
  }

  await prisma.link.update({
    where: { id: linkId },
    data: {
      type: linkType,
    },
  });

  return { linkType, imageExtension };
}

// Construct browser launch options based on environment variables.
export function getBrowserOptions(): LaunchOptions {
  let browserOptions: LaunchOptions = {};

  if (process.env.PROXY) {
    browserOptions.proxy = {
      server: process.env.PROXY,
      bypass: process.env.PROXY_BYPASS,
      username: process.env.PROXY_USERNAME,
      password: process.env.PROXY_PASSWORD,
    };
  }

  if (
    process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH &&
    !process.env.PLAYWRIGHT_WS_URL
  ) {
    browserOptions.executablePath =
      process.env.PLAYWRIGHT_LAUNCH_OPTIONS_EXECUTABLE_PATH;
  }

  return browserOptions;
}

async function solveCaptcha(url: string, maxTimeout: number = 60000): Promise<{
  status: string,
  solution?: {
    cookies: {
      name: string,
      value: string,
      domain: string,
      path: string,
      secure: boolean,
      expires?: number,
      httpOnly?: boolean,
      sameSite?: "Strict" | "Lax" | "None"
    }[],
  }
}> {
  if (process.env.FLARESOLVERR_URL) {
    try {
      const response = await axios.post(process.env.FLARESOLVERR_URL,
        {
          cmd: 'request.get',
          url,
          maxTimeout
        },
        {
          headers: { 'Content-Type': 'application/json' }
        }
      )

      if (response.status !== 200) {
        return { status: 'fail' };
      }

      return { status: response.data.status, solution: response.data.solution };
    } catch (error) {
      console.error('Error during captcha solving:', error);
      return { status: 'error' };
    }
  }

  return { status: 'skip' };
}

async function getBrowser(): Promise<{
  browser: Browser;
  context: BrowserContext;
}> {
  const browserOptions = getBrowserOptions();
  let browser: Browser;
  let contextOptions: BrowserContextOptions = {
    ...devices["Desktop Chrome"],
    ignoreHTTPSErrors: process.env.IGNORE_HTTPS_ERRORS === "true",
  };

  if (process.env.PLAYWRIGHT_WS_URL) {
    browser = await chromium.connectOverCDP(process.env.PLAYWRIGHT_WS_URL);
    contextOptions = {
      ...contextOptions,
      ...browserOptions,
    };
  } else {
    browser = await chromium.launch(browserOptions);
  }

  const context = await browser.newContext(contextOptions);

  return { browser, context };
}
