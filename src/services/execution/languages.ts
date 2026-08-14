/**
 * Judge0 language ids are the source of truth.
 *
 * The old platform hard-coded three string language slugs because a problem
 * statement pinned the language. A research engine should accept anything the
 * configured Judge0 instance supports, so the API takes a numeric
 * `languageId` and this table exists only to label runs in the UI and to map
 * the subset the local Docker backend can handle.
 *
 * Ids match Judge0 CE 1.13.x: https://ce.judge0.com/languages
 */
export interface LanguageInfo {
  id: number;
  name: string;
  /** Source file extension used by the local Docker backend. */
  ext: string;
}

export const LANGUAGES: LanguageInfo[] = [
  { id: 71, name: 'Python (3.8.1)', ext: 'py' },
  { id: 70, name: 'Python (2.7.17)', ext: 'py' },
  { id: 63, name: 'JavaScript (Node.js 12.14.0)', ext: 'js' },
  { id: 74, name: 'TypeScript (3.7.4)', ext: 'ts' },
  { id: 54, name: 'C++ (GCC 9.2.0)', ext: 'cpp' },
  { id: 50, name: 'C (GCC 9.2.0)', ext: 'c' },
  { id: 62, name: 'Java (OpenJDK 13.0.1)', ext: 'java' },
  { id: 60, name: 'Go (1.13.5)', ext: 'go' },
  { id: 72, name: 'Ruby (2.7.0)', ext: 'rb' },
  { id: 73, name: 'Rust (1.40.0)', ext: 'rs' },
  { id: 80, name: 'R (4.0.0)', ext: 'r' },
  { id: 46, name: 'Bash (5.0.0)', ext: 'sh' },
];

const BY_ID = new Map(LANGUAGES.map((language) => [language.id, language]));

export function languageInfo(id: number): LanguageInfo | undefined {
  return BY_ID.get(id);
}

export function languageName(id: number): string {
  return BY_ID.get(id)?.name ?? `Language ${id}`;
}

/**
 * Ids the local Docker backend can run, mapped to an image and commands.
 *
 * Deliberately a subset — the point of the Docker backend is to keep the
 * engine usable on a cgroup v2 host, not to reimplement Judge0's 60 languages.
 * Anything not listed fails with an explicit message rather than silently
 * producing a wrong verdict.
 */
export interface DockerLanguageSpec {
  imageEnv: 'python' | 'node' | 'cpp';
  filename: string;
  /** Compiler invocation writing /build/bin. Omit for interpreted languages. */
  compile?: string;
  run: string;
}

export const DOCKER_LANGUAGES: Record<number, DockerLanguageSpec> = {
  70: { imageEnv: 'python', filename: 'main.py', run: 'python3 /tmp/main.py' },
  71: { imageEnv: 'python', filename: 'main.py', run: 'python3 /tmp/main.py' },
  63: { imageEnv: 'node', filename: 'main.js', run: 'node /tmp/main.js' },
  50: {
    imageEnv: 'cpp',
    filename: 'main.c',
    compile: 'gcc -O2 -o /build/bin /tmp/main.c',
    run: '/build/bin',
  },
  54: {
    imageEnv: 'cpp',
    filename: 'main.cpp',
    compile: 'g++ -O2 -std=c++17 -o /build/bin /tmp/main.cpp',
    run: '/build/bin',
  },
};

export function isDockerSupported(languageId: number): boolean {
  return languageId in DOCKER_LANGUAGES;
}
