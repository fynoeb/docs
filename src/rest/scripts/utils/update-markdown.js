import path from 'path'
import mkdirp from 'mkdirp'
import rimraf from 'rimraf'
import { existsSync } from 'fs'
import walk from 'walk-sync'
import matter from 'gray-matter'
import { difference } from 'lodash-es'
import { readFile, writeFile, unlink, readdir } from 'fs/promises'

import { allVersions, getDocsVersion } from '../../../../lib/all-versions.js'
import { REST_DATA_DIR, REST_SCHEMA_FILENAME } from '../../lib/index.js'

const frontmatterDefaults = JSON.parse(
  await readFile('src/rest/lib/config.json', 'utf-8')
).frontmatterDefaults

export async function updateMarkdownFiles() {
  const restVersions = await getDataFrontmatter(REST_DATA_DIR, REST_SCHEMA_FILENAME)
  const restContentFrontmatter = await getMarkdownFrontmatter(restVersions)
  const restContentFiles = Object.keys(restContentFrontmatter)
  // Get a list of existing markdown files so we can make deletions
  const restMarkdownFiles = walk('content/rest', {
    includeBasePath: true,
    directories: false,
  }).filter((file) => !file.includes('index.md') && !file.includes('README.md'))
  const existingAutogeneratedFiles = (
    await Promise.all(
      restMarkdownFiles.map(async (file) => {
        const data = await readFile(file, 'utf-8')
        const frontmatter = matter(data)
        if (frontmatter.data.autogenerated === 'rest') {
          return file
        }
      })
    )
  ).filter(Boolean)

  // If the first array contains items that the second array does not,
  // it means that a Markdown page was deleted from the OpenAPI schema
  const filesToRemove = difference(existingAutogeneratedFiles, restContentFiles)

  // Markdown files that need to be deleted
  for (const file of filesToRemove) {
    await unlink(file)
    // If after removing the file, the directory only contains an index.md file,
    // the whole directory can be removed and the index.md file one level up
    // needs to be updated to remove the deleted directory from its children
    const directoryFiles = await readdir(path.dirname(file))
    if (directoryFiles.length === 1 && directoryFiles[0] === 'index.md') {
      rimraf.sync(path.dirname(file))
      await updateIndexFile(path.dirname(file), 'remove')
    } else {
      await updateIndexFile(file, 'remove')
    }
  }

  // Markdown files that need to be added or updated
  for (const [file, newFrontmatter] of Object.entries(restContentFrontmatter)) {
    if (existsSync(file)) {
      // update only the versions property of the file, assuming
      // the other properties have already been added and edited
      const { data, content } = matter(await readFile(file, 'utf-8'))
      data.versions = newFrontmatter.versions
      await writeFile(file, matter.stringify(content, data))
    } else {
      // When a new category is added with more than one subcategory,
      // a new directory with the category name needs to be created
      // and added to the content/rest/index.md file
      if (!existsSync(path.dirname(file))) {
        await mkdirp(path.dirname(file))
        updateIndexFile(path.dirname(file), 'add')
      }
      await writeFile(file, matter.stringify('', newFrontmatter))
      updateIndexFile(file, 'add', newFrontmatter.versions)
    }
  }
}

// Adds or removes children properties from index.md pages
async function updateIndexFile(file, changeType, versions = null) {
  const filename = path.basename(file, '.md')
  const indexDirectory = path.basename(path.dirname(file))
  const indexFilePath = path.join(path.dirname(file), 'index.md')

  // A default index file to use as a placeholder when one doesn't exist
  const newIndexFile = {
    data: {
      title: indexDirectory,
      shortTitle: indexDirectory,
      intro: '',
      versions,
      ...frontmatterDefaults,
      children: [],
    },
    content: '',
  }
  const { data, content } = existsSync(indexFilePath)
    ? matter(await readFile(indexFilePath, 'utf-8'))
    : newIndexFile

  if (changeType === 'remove') {
    const index = data.children.indexOf(`/${filename}`)
    data.children.splice(index, 1)
  }
  if (changeType === 'add') {
    data.children.push(`/${filename}`)
  }
  await writeFile(indexFilePath, matter.stringify(content, data))
}

/* Takes a list of versions in the format:
[
  'free-pro-team@latest',
  'enterprise-cloud@latest',
  'enterprise-server@3.3',
  'enterprise-server@3.4',
  'enterprise-server@3.5',
  'enterprise-server@3.6',
  'enterprise-server@3.7',
  'github-ae@latest'
]
and returns the frontmatter equivalent JSON:
{ 
  fpt: '*',
  ghae: '*',
  ghec: '*', 
  ghes: '*' 
}
*/
export async function convertVersionsToFrontmatter(versions) {
  const frontmatterVersions = {}
  const numberedReleases = {}

  // Currently, only GHES is numbered. Number releases have to be
  // handled differently because they use semantic versioning.
  versions.forEach((version) => {
    const docsVersion = allVersions[version]
    if (!docsVersion.hasNumberedReleases) {
      frontmatterVersions[docsVersion.shortName] = '*'
    } else {
      // Each version that has numbered releases in allVersions
      // has a string for the number (currentRelease) and an array
      // of all of the available releases (e.g. ['3.3', '3.4', '3.5'])
      // This creates an array of the applicable releases in the same
      // order as the available releases array. This is used to track when
      // a release is no longer supported.
      const i = docsVersion.releases.sort().indexOf(docsVersion.currentRelease)
      if (!numberedReleases[docsVersion.shortName]) {
        const availableReleases = Array(docsVersion.releases.length).fill(undefined)
        availableReleases[i] = docsVersion.currentRelease
        numberedReleases[docsVersion.shortName] = {
          availableReleases,
        }
      } else {
        numberedReleases[docsVersion.shortName].availableReleases[i] = docsVersion.currentRelease
      }
    }
  })

  // Create semantic versions for numbered releases
  Object.keys(numberedReleases).forEach((key) => {
    const availableReleases = numberedReleases[key].availableReleases
    const versionContinuity = checkVersionContinuity(availableReleases)
    if (availableReleases.every(Boolean)) {
      frontmatterVersions[key] = '*'
    } else if (!versionContinuity) {
      // If there happens to be version gaps, just enumerate each version
      // using syntax like =3.x || =3.x
      const semVer = availableReleases
        .filter(Boolean)
        .map((release) => `=${release}`)
        .join(' || ')
      frontmatterVersions[key] = semVer
    } else {
      const semVer = []
      if (!availableReleases[availableReleases.length - 1]) {
        const endVersion = availableReleases.filter(Boolean).pop()
        semVer.push(`<=${endVersion}`)
      }
      if (!availableReleases[0]) {
        const startVersion = availableReleases.filter(Boolean).shift()
        semVer.push(`>=${startVersion}`)
      }
      frontmatterVersions[key] = semVer.join(' ')
    }
  })
  const sortedFrontmatterVersions = Object.keys(frontmatterVersions)
    .sort()
    .reduce((acc, key) => {
      acc[key] = frontmatterVersions[key]
      return acc
    }, {})
  return sortedFrontmatterVersions
}

// This is uncommon, but we potentially could have the case where an
// article was versioned for say 3.2, not for 3.3, and then again
// versioned for 3.4. This will result in a custom semantic version range
function checkVersionContinuity(versions) {
  const availableVersions = [...versions]

  // values at the beginning or end of the array are not gaps but normal
  // starts and ends of version ranges
  while (!availableVersions[0]) {
    availableVersions.shift()
  }
  while (!availableVersions[availableVersions.length - 1]) {
    availableVersions.pop()
  }
  return availableVersions.every(Boolean)
}

// Reads data files from the directory provided and returns a
// JSON object that lists the versions for each category/subcategory
// The data files are split up by version, so all files must be
// read to get a complete list of versions.
async function getDataFrontmatter(dataDirectory, schemaFilename) {
  const fileList = walk(dataDirectory, { includeBasePath: true }).filter(
    (file) => path.basename(file) === schemaFilename
  )

  const restVersions = {}

  for (const file of fileList) {
    const data = JSON.parse(await readFile(file, 'utf-8'))
    const docsVersionName = getDocsVersion(path.basename(path.dirname(file)))
    Object.keys(data).forEach((category) => {
      // Used to automatically update Markdown files
      const subcategories = Object.keys(data[category])
      subcategories.forEach((subcategory) => {
        if (!restVersions[category]) {
          restVersions[category] = {}
        }
        if (!restVersions[category][subcategory]) {
          restVersions[category][subcategory] = {
            versions: [docsVersionName],
          }
        } else if (!restVersions[category][subcategory].versions.includes(docsVersionName)) {
          restVersions[category][subcategory].versions.push(docsVersionName)
        }
      })
    })
  }
  return restVersions
}

/*
  Take an object that includes the version frontmatter 
  that should be applied to the Markdown page that corresponds
  to the category and subcategory. The format looks like this:
  {
    "actions": {
      "artifacts": {
        "versions": {
          "free-pro-team@latest",
          "github-ae@latest",
          "enterprise-cloud@latest",
          "enterprise-server@3.4",
          "enterprise-server@3.5",
          "enterprise-server@3.6",
          "enterprise-server@3.7",
          "enterprise-server@3.8"
        }
      }
    }
  }
*/
async function getMarkdownFrontmatter(versions) {
  const markdownUpdates = {}

  for (const category of Object.keys(versions)) {
    const subcategories = Object.keys(versions[category])
    // When there is only a single subcategory, the Markdown file
    // will be at the root of the content/rest directory. The
    // filen path will be content/rest/<category>.md
    if (subcategories.length === 1) {
      // this will be a file in the root of the rest directory
      const filepath = path.join('content/rest', `${category}.md`)
      markdownUpdates[filepath] = {
        title: category,
        shortTitle: category,
        intro: '',
        versions: await convertVersionsToFrontmatter(versions[category][subcategories[0]].versions),
        ...frontmatterDefaults,
      }
      continue
    }

    // The file path will be content/rest/<category>/<subcategory>.md
    for (const subcategory of subcategories) {
      const filepath = path.join('content/rest', category, `${subcategory}.md`)
      markdownUpdates[filepath] = {
        title: subcategory,
        shortTitle: subcategory,
        intro: '',
        versions: await convertVersionsToFrontmatter(versions[category][subcategory].versions),
        ...frontmatterDefaults,
      }
    }
  }

  return markdownUpdates
}
