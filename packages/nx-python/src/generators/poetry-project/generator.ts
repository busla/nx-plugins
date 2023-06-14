import {
  addProjectConfiguration,
  formatFiles,
  generateFiles,
  getWorkspaceLayout,
  names,
  offsetFromRoot,
  ProjectConfiguration,
  readProjectConfiguration,
  Tree,
} from '@nrwl/devkit';
import * as path from 'path';
import { PoetryProjectGeneratorSchema } from './schema';
import { checkPoetryExecutable, runPoetry } from '../../executors/utils/poetry';
import {
  PyprojectToml,
  PyprojectTomlDependencies,
} from '../../graph/dependency-graph';
import { parse, stringify } from '@iarna/toml';
import chalk from 'chalk';
import _ from 'lodash';

interface NormalizedSchema extends PoetryProjectGeneratorSchema {
  projectName: string;
  projectRoot: string;
  projectDirectory: string;
  individualPackage: boolean;
  devDependenciesProjectPath?: string;
  pythonAddopts?: string;
  parsedTags: string[];
}

function normalizeOptions(
  tree: Tree,
  options: PoetryProjectGeneratorSchema
): NormalizedSchema {
  const name = names(options.name).fileName;
  const projectDirectory = options.directory
    ? `${names(options.directory).fileName}/${name}`
    : name;
  const projectName = projectDirectory.replace(new RegExp('/', 'g'), '-');
  const projectRoot = `${
    options.projectType === 'application'
      ? getWorkspaceLayout(tree).appsDir
      : getWorkspaceLayout(tree).libsDir
  }/${projectDirectory}`;
  const parsedTags = options.tags
    ? options.tags.split(',').map((s) => s.trim())
    : [];

  const newOptions = _.clone(options) as NormalizedSchema;

  if (!options.pyprojectPythonDependency) {
    newOptions.pyprojectPythonDependency = '>=3.9,<3.11';
  }

  if (!options.pyenvPythonVersion) {
    newOptions.pyenvPythonVersion = '3.9.5';
  }

  if (!options.moduleName) {
    newOptions.moduleName = projectName.replace(new RegExp('-', 'g'), '_');
  }

  if (!options.packageName) {
    newOptions.packageName = projectName;
  }

  if (!options.description) {
    newOptions.description = 'Automatically generated by Nx.';
  }
  if (options.devDependenciesProject) {
    const projectConfig = readProjectConfiguration(
      tree,
      options.devDependenciesProject
    );
    newOptions.devDependenciesProjectPath = path.relative(
      projectRoot,
      projectConfig.root
    );
  }

  let pythonAddopts = undefined;

  if (options.unitTestRunner === 'pytest') {
    const args = [];
    const offset = offsetFromRoot(projectRoot);
    if (options.codeCoverage) {
      args.push('--cov');
    }
    if (options.codeCoverageThreshold) {
      args.push(`--cov-fail-under=${options.codeCoverageThreshold}`);
    }
    if (options.codeCoverage && options.codeCoverageHtmlReport) {
      args.push(`--cov-report html:'${offset}coverage/${projectRoot}/html'`);
    }

    if (options.codeCoverage && options.codeCoverageXmlReport) {
      args.push(
        `--cov-report xml:'${offset}coverage/${projectRoot}/coverage.xml'`
      );
    }

    if (options.unitTestHtmlReport) {
      args.push(
        `--html='${offset}reports/${projectRoot}/unittests/html/index.html'`
      );
    }

    if (options.unitTestJUnitReport) {
      args.push(
        `--junitxml='${offset}reports/${projectRoot}/unittests/junit.xml'`
      );
    }

    pythonAddopts = args.join(' ');
  }

  if (options.unitTestRunner === 'none') {
    newOptions.unitTestHtmlReport = false;
    newOptions.unitTestJUnitReport = false;
    newOptions.codeCoverage = false;
    newOptions.codeCoverageHtmlReport = false;
    newOptions.codeCoverageXmlReport = false;
    newOptions.codeCoverageThreshold = undefined;
  }

  return {
    ...options,
    ...newOptions,
    devDependenciesProject: options.devDependenciesProject || '',
    individualPackage: !tree.exists('pyproject.toml'),
    pythonAddopts,
    projectName,
    projectRoot,
    projectDirectory,
    parsedTags,
  };
}

function addFiles(tree: Tree, options: NormalizedSchema) {
  const templateOptions = {
    ...options,
    ...names(options.name),
    offsetFromRoot: offsetFromRoot(options.projectRoot),
    template: '',
    dot: '.',
  };
  if (options.templateDir) {
    generateFiles(
      tree,
      path.join(options.templateDir),
      options.projectRoot,
      templateOptions
    );
    return;
  }

  generateFiles(
    tree,
    path.join(__dirname, 'files', 'base'),
    options.projectRoot,
    templateOptions
  );

  if (options.unitTestRunner === 'pytest') {
    generateFiles(
      tree,
      path.join(__dirname, 'files', 'pytest'),
      options.projectRoot,
      templateOptions
    );
  }

  if (options.linter === 'flake8') {
    generateFiles(
      tree,
      path.join(__dirname, 'files', 'flake8'),
      options.projectRoot,
      templateOptions
    );
  }
}

function updateRootPyprojectToml(
  host: Tree,
  normalizedOptions: NormalizedSchema
) {
  if (normalizedOptions.devDependenciesProject) {
    const projectConfig = readProjectConfiguration(
      host,
      normalizedOptions.devDependenciesProject
    );
    const devDepsPyprojectTomlPath = path.join(
      projectConfig.root,
      'pyproject.toml'
    );

    const devDepsPyprojectToml = parse(
      host.read(devDepsPyprojectTomlPath, 'utf-8')
    ) as PyprojectToml;

    const { changed, dependencies } = addTestDependencies(
      devDepsPyprojectToml.tool.poetry.dependencies,
      normalizedOptions
    );

    if (changed) {
      devDepsPyprojectToml.tool.poetry.dependencies = {
        ...devDepsPyprojectToml.tool.poetry.dependencies,
        ...dependencies,
      };

      host.write(devDepsPyprojectTomlPath, stringify(devDepsPyprojectToml));
    }
  }

  if (!normalizedOptions.individualPackage) {
    const rootPyprojectToml = parse(
      host.read('./pyproject.toml', 'utf-8')
    ) as PyprojectToml;

    const group = normalizedOptions.rootPyprojectDependencyGroup ?? 'main';

    if (group === 'main') {
      rootPyprojectToml.tool.poetry.dependencies[
        normalizedOptions.packageName
      ] = {
        path: normalizedOptions.projectRoot,
        develop: true,
      };
    } else {
      rootPyprojectToml.tool.poetry.group = {
        ...(rootPyprojectToml.tool.poetry.group || {}),
        [group]: {
          ...(rootPyprojectToml.tool.poetry.group?.[group] || {}),
          dependencies: {
            ...(rootPyprojectToml.tool.poetry.group?.[group]?.dependencies ||
              {}),
            [normalizedOptions.packageName]: {
              path: normalizedOptions.projectRoot,
              develop: true,
            },
          },
        },
      };
    }

    if (!normalizedOptions.devDependenciesProject) {
      const { changed, dependencies } = addTestDependencies(
        rootPyprojectToml.tool.poetry.group?.dev?.dependencies || {},
        normalizedOptions
      );

      if (changed) {
        rootPyprojectToml.tool.poetry.group = {
          ...(rootPyprojectToml.tool.poetry.group || {}),
          dev: {
            dependencies: dependencies,
          },
        };
      }
    }

    host.write('./pyproject.toml', stringify(rootPyprojectToml));
  }
}

function addTestDependencies(
  dependencies: PyprojectTomlDependencies,
  normalizedOptions: NormalizedSchema
) {
  const originalDependencies = _.clone(dependencies);

  if (normalizedOptions.linter === 'flake8' && !dependencies['flake8']) {
    dependencies['flake8'] = '6.0.0';
  }

  if (!dependencies['autopep8']) {
    dependencies['autopep8'] = '2.0.2';
  }

  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    !dependencies['pytest']
  ) {
    dependencies['pytest'] = '7.3.1';
  }
  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    !dependencies['pytest-sugar']
  ) {
    dependencies['pytest-sugar'] = '0.9.7';
  }

  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    normalizedOptions.codeCoverage &&
    !dependencies['pytest-cov']
  ) {
    dependencies['pytest-cov'] = '4.1.0';
  }

  if (
    normalizedOptions.unitTestRunner === 'pytest' &&
    normalizedOptions.codeCoverageHtmlReport &&
    !dependencies['pytest-html']
  ) {
    dependencies['pytest-html'] = '3.2.0';
  }

  return {
    changed: !_.isEqual(originalDependencies, dependencies),
    dependencies,
  };
}

function updateRootPoetryLock(host: Tree, normalizedOptions: NormalizedSchema) {
  if (host.exists('./pyproject.toml')) {
    console.log(chalk`  Updating root {bgBlue poetry.lock}...`);
    const updateArgs = ['update', normalizedOptions.packageName];
    runPoetry(updateArgs, { log: false });
    console.log(chalk`\n  {bgBlue poetry.lock} updated.\n`);
  }
}

export default async function (
  tree: Tree,
  options: PoetryProjectGeneratorSchema
) {
  await checkPoetryExecutable();

  const normalizedOptions = normalizeOptions(tree, options);

  const targets: ProjectConfiguration['targets'] = {
    lock: {
      executor: 'nx:run-commands',
      options: {
        command: 'poetry lock --no-update',
        cwd: normalizedOptions.projectRoot,
      },
    },
    add: {
      executor: '@nxlv/python:add',
      options: {},
    },
    update: {
      executor: '@nxlv/python:update',
      options: {},
    },
    remove: {
      executor: '@nxlv/python:remove',
      options: {},
    },
    build: {
      executor: '@nxlv/python:build',
      outputs: ['{projectRoot}/dist'],
      options: {
        outputPath: `${normalizedOptions.projectRoot}/dist`,
        publish: normalizedOptions.publishable,
        lockedVersions: normalizedOptions.buildLockedVersions,
        bundleLocalDependencies: normalizedOptions.buildBundleLocalDependencies,
      },
    },
    install: {
      executor: '@nxlv/python:install',
      options: {
        silent: false,
        args: '',
        cacheDir: `.cache/pypoetry`,
        verbose: false,
        debug: false,
      },
    },
  };

  if (options.linter === 'flake8') {
    targets.lint = {
      executor: '@nxlv/python:flake8',
      outputs: [
        `{workspaceRoot}/reports/${normalizedOptions.projectRoot}/pylint.txt`,
      ],
      options: {
        outputFile: `reports/${normalizedOptions.projectRoot}/pylint.txt`,
      },
    };
  }

  if (options.unitTestRunner === 'pytest') {
    targets.test = {
      executor: 'nx:run-commands',
      outputs: [
        `{workspaceRoot}/reports/${normalizedOptions.projectRoot}/unittests`,
        `{workspaceRoot}/coverage/${normalizedOptions.projectRoot}`,
      ],
      options: {
        command: `poetry run pytest tests/`,
        cwd: normalizedOptions.projectRoot,
      },
    };
  }

  addProjectConfiguration(tree, normalizedOptions.projectName, {
    root: normalizedOptions.projectRoot,
    projectType: normalizedOptions.projectType,
    sourceRoot: `${normalizedOptions.projectRoot}/${normalizedOptions.moduleName}`,
    targets,
    tags: normalizedOptions.parsedTags,
  });
  addFiles(tree, normalizedOptions);
  updateRootPyprojectToml(tree, normalizedOptions);
  await formatFiles(tree);

  return () => {
    updateRootPoetryLock(tree, normalizedOptions);
  };
}
