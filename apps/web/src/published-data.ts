import type { ArticleCard, IssueSectionView, IssueView } from '@paper/shared';

export interface PublishedArticle extends Omit<ArticleCard, 'sourceId' | 'readingStatus'> {
  contentText: string | null;
  isSample: boolean;
}

export interface PublishedSection extends Omit<IssueSectionView, 'articles'> {
  articles: PublishedArticle[];
}

export interface PublishedIssue extends Pick<IssueView, 'id' | 'issueDate' | 'issueNumber' | 'masthead' | 'theme'> {
  sections: PublishedSection[];
}

export interface PublishedSnapshot {
  exportedAt: string;
  issues: PublishedIssue[];
}
