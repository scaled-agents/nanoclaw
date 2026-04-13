/**
 * YouTube Integration - MCP Server (Container Side)
 *
 * Runs inside the container as a stdio MCP server.
 * Fetches YouTube video transcripts directly via youtube-transcript-plus
 * (no IPC, no browser automation needed).
 */

import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import {
  YoutubeTranscript,
  toPlainText,
  toSRT,
  toVTT,
} from 'youtube-transcript-plus';

const server = new McpServer({
  name: 'youtube',
  version: '1.0.0',
});

/**
 * Extract a YouTube video ID from a URL or pass through a raw ID.
 * Supports: youtube.com/watch?v=, youtu.be/, youtube.com/embed/, youtube.com/shorts/
 */
function extractVideoId(input: string): string {
  const trimmed = input.trim();

  // Full URL patterns
  const patterns = [
    /(?:youtube\.com\/watch\?.*v=)([a-zA-Z0-9_-]{11})/,
    /(?:youtu\.be\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/embed\/)([a-zA-Z0-9_-]{11})/,
    /(?:youtube\.com\/shorts\/)([a-zA-Z0-9_-]{11})/,
  ];

  for (const pattern of patterns) {
    const match = trimmed.match(pattern);
    if (match) return match[1];
  }

  // Raw 11-character ID
  if (/^[a-zA-Z0-9_-]{11}$/.test(trimmed)) return trimmed;

  // Pass through as-is and let the library handle validation
  return trimmed;
}

server.tool(
  'youtube_get_transcript',
  `Fetch the transcript of a YouTube video as plain text.
Returns the full transcript text along with video metadata (title, author, duration, view count).
Supports auto-generated captions. Use youtube_list_languages first if you need a specific language.`,
  {
    video: z
      .string()
      .describe(
        'YouTube video URL (e.g., https://youtube.com/watch?v=xyz) or video ID',
      ),
    lang: z
      .string()
      .optional()
      .describe(
        'BCP 47 language code (e.g., "en", "fr", "pt-BR"). Defaults to "en".',
      ),
  },
  async (args) => {
    try {
      const videoId = extractVideoId(args.video);
      const result = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: args.lang || 'en',
        videoDetails: true,
        retries: 2,
        retryDelay: 1000,
      });

      const text = toPlainText(result.segments, ' ');
      const details = result.videoDetails;

      const header = [
        `Title: ${details.title}`,
        `Author: ${details.author}`,
        `Duration: ${Math.floor(details.lengthSeconds / 60)}m ${details.lengthSeconds % 60}s`,
        `Views: ${details.viewCount.toLocaleString()}`,
        `Segments: ${result.segments.length}`,
        '',
        '--- Transcript ---',
        '',
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: header + text }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to fetch transcript: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'youtube_get_transcript_timed',
  `Fetch the transcript of a YouTube video with timestamps in SRT or VTT format.
Useful when you need to reference specific moments in the video.`,
  {
    video: z
      .string()
      .describe(
        'YouTube video URL (e.g., https://youtube.com/watch?v=xyz) or video ID',
      ),
    lang: z
      .string()
      .optional()
      .describe(
        'BCP 47 language code (e.g., "en", "fr"). Defaults to "en".',
      ),
    format: z
      .enum(['srt', 'vtt'])
      .optional()
      .describe('Output format: "srt" (default) or "vtt".'),
  },
  async (args) => {
    try {
      const videoId = extractVideoId(args.video);
      const result = await YoutubeTranscript.fetchTranscript(videoId, {
        lang: args.lang || 'en',
        videoDetails: true,
        retries: 2,
        retryDelay: 1000,
      });

      const formatter = args.format === 'vtt' ? toVTT : toSRT;
      const formatted = formatter(result.segments);
      const details = result.videoDetails;

      const header = [
        `Title: ${details.title}`,
        `Author: ${details.author}`,
        `Duration: ${Math.floor(details.lengthSeconds / 60)}m ${details.lengthSeconds % 60}s`,
        '',
      ].join('\n');

      return {
        content: [{ type: 'text' as const, text: header + formatted }],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to fetch transcript: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

server.tool(
  'youtube_list_languages',
  `List available caption/subtitle tracks for a YouTube video.
Shows which languages have transcripts and whether they are auto-generated.
Use this to find valid language codes before calling youtube_get_transcript.`,
  {
    video: z
      .string()
      .describe(
        'YouTube video URL (e.g., https://youtube.com/watch?v=xyz) or video ID',
      ),
  },
  async (args) => {
    try {
      const videoId = extractVideoId(args.video);
      const tracks = await YoutubeTranscript.listLanguages(videoId);

      const lines = tracks.map(
        (t) =>
          `${t.languageCode} — ${t.languageName}${t.isAutoGenerated ? ' (auto-generated)' : ''}`,
      );

      return {
        content: [
          {
            type: 'text' as const,
            text:
              lines.length > 0
                ? `Available caption tracks (${lines.length}):\n\n${lines.join('\n')}`
                : 'No caption tracks available for this video.',
          },
        ],
      };
    } catch (err) {
      return {
        content: [
          {
            type: 'text' as const,
            text: `Failed to list languages: ${err instanceof Error ? err.message : String(err)}`,
          },
        ],
        isError: true,
      };
    }
  },
);

// Start the stdio transport
const transport = new StdioServerTransport();
await server.connect(transport);
