import CopyPlugin from 'copy-webpack-plugin';
import { TransformAsyncModulesPlugin } from 'transform-async-modules-webpack-plugin';
import pkgJson from './package.json' with { type: 'json' };
import TerserPlugin from 'terser-webpack-plugin';
import { createRequire } from 'module';
import path from 'path';
import { fileURLToPath } from 'url';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const requireCjs = createRequire(import.meta.url);
const { AssertNoBareRequirePlugin } = requireCjs('./tools/assert-no-bare-require.cjs');

const STAGING_APP_ID = 'com.zui.webos.youtube.staging';
const STAGING_APP_TITLE = 'ZUI YouTube STAGING';
// Acceptance overlay only: production package/appinfo version stays unchanged.
const STAGING_APP_VERSION = '0.8.5';

const stagingAppInfoTransform = {
  /** @param {Buffer} content */
  transformer(content) {
    const appInfo = JSON.parse(content.toString());
    appInfo.id = STAGING_APP_ID;
    appInfo.title = STAGING_APP_TITLE;
    appInfo.version = STAGING_APP_VERSION;
    return `${JSON.stringify(appInfo, null, 2)}\n`;
  }
};

/** @type {(env: Record<string, string>) => (import('webpack').Configuration)[]} */
const makeConfig = (env) => {
  const isModern = !!(env && env.modern);
  const isStaging = !!(env && env.staging);
  // Dev-only instrumentation; see src/perf_mon.js. Off unless `--env perf`.
  const withPerfMon = !!(env && env.perf);

  const assetPatterns = isStaging
    ? [
        { context: 'assets', from: '**/*', globOptions: { ignore: ['**/appinfo.json'] } },
        { from: 'assets/appinfo.json', to: 'appinfo.json', transform: stagingAppInfoTransform }
      ]
    : [{ context: 'assets', from: '**/*' }];

  return [
    {
      target: isModern ? 'browserslist:chrome 87' : ['web', 'es5'],
      devtool: false,
      entry: {
        index: './src/index.js',
        userScript: {
          import: './src/userScript.js',
          filename: 'webOSUserScripts/[name].js'
        }
      },
      resolve: {
        extensions: ['.mjs', '.cjs', '.js', '.json', '.ts'],
        alias: {
          ...(!env?.yttr ? { [path.resolve(__dirname, 'src/turkish-captions-poc.js')]: false } : {}),
          ...(withPerfMon
            ? {}
            : { [path.resolve(__dirname, 'src/perf_mon.js')]: false }),
          ...(isModern ? {
          // Strip global polyfills for modern build
          'core-js-pure': false,
          '@babel/runtime-corejs3': false,
          'regenerator-runtime': false,
          'regenerator-runtime/runtime': false,
          'whatwg-fetch': false,
          
          // Strip local polyfills
          [path.resolve(__dirname, 'src/spatial-navigation-polyfill.js')]: path.resolve(__dirname, 'src/spatial-navigation.modern.js'),
          // Chrome 87 has every built-in polyfills.js installs, so the whole
          // file is dead weight (and a pile of no-op feature checks) here.
          [path.resolve(__dirname, 'src/polyfills.js')]: false,
          [path.resolve(__dirname, 'src/domrect-polyfill.js')]: false,
          [path.resolve(__dirname, 'src/emoji-font.js')]: false,
		  [path.resolve(__dirname, 'src/hooks/buffer-limit.js')]: false,
          [path.resolve(__dirname, 'src/emoji-font.css')]: false
          } : {})
        }
      },
      module: {
        rules: [
          {
            test: /\.[mc]?[jt]s$/i,
            loader: 'babel-loader',
            // Restore original exclude for legacy to maintain compatibility
            // Modern build excludes all node_modules for speed
            exclude: isModern 
              ? /node_modules/ 
              : [
                  /node_modules[\\/]core-js/,
                  /node_modules[\\/]webpack[\\/]buildin/
                ],
            options: isModern ? {
              // modern config
              cacheDirectory: true,
              babelrc: false,
              configFile: false,
              presets: [
                ['@babel/preset-env', {
                  targets: 'chrome 87', 
                  bugfixes: true,
                  modules: false,
                  useBuiltIns: false
                }]
                // REMOVED missing '@babel/preset-typescript'
              ],
              plugins: [
                 // Use the plugin you already have installed instead of the preset
                 ['@babel/plugin-transform-typescript', { strictMode: true }]
              ]
            } : {
              // LEGACY CONFIGURATION (Uses babel.config.js)
              cacheDirectory: true
            },
            resolve: {
              fullySpecified: false
            }
          },
          {
            test: /\.(png|svg)$/i,
            type: 'asset/inline'
          },
          {
            test: /\.css$/i,
            use: [
              { loader: 'style-loader' },
              {
                loader: 'css-loader',
                options: { 
                  esModule: false, 
                  importLoaders: 1,
                  modules: false
                }
              },
              {
                loader: 'postcss-loader',
                options: {
                  postcssOptions: {
                    plugins: [
                      ['cssnano', {
                        preset: ['default', {
                          discardComments: { removeAll: true },
                          normalizeWhitespace: true,
                          colormin: true,
                          minifySelectors: true,
                          minifyFontValues: true,
                        }]
                      }]
                    ]
                  }
                }
              }
            ]
          }
        ]
      },
      optimization: {
        minimize: true,
        minimizer: [
          new TerserPlugin({
            terserOptions: {
              format: {
                comments: false,
                ascii_only: true,
              },
              compress: {
                drop_console: false,
                 drop_debugger: true,
                passes: 4,
                arrows: isModern,
                ecma: isModern ? 2020 : 5,
              },
              mangle: isModern ? true : { safari10: true },
            },
            extractComments: false,
          }),
        ],
      },
      performance: {
        hints: false,
      },
      plugins: [
        // Catches the "ReferenceError: require is not defined" failure mode at
        // build time instead of on the TV. See the plugin for the full story.
        new AssertNoBareRequirePlugin(),
        new CopyPlugin({
          patterns: [
            ...assetPatterns,
            { context: 'src', from: 'index.html' }
          ]
        }),
        // Only add Async Module support for Legacy builds
        ...(isModern ? [] : [
          new TransformAsyncModulesPlugin({
            // @ts-expect-error Bad types
            runtime: {
              version: pkgJson.devDependencies['@babel/plugin-transform-runtime']
            }
          })
        ])
      ]
    }
  ];
};

export default makeConfig;
