import React from 'react';
import { render, screen, fireEvent } from '@testing-library/react';
import '@testing-library/jest-dom';
import InboxItemDetail from '../InboxItemDetail';

jest.mock('react-i18next', () => ({
    useTranslation: () => ({
        t: (_key: string, fallback: string) => fallback,
    }),
}));

jest.mock('../../../store/useStore', () => ({
    useStore: () => ({ tagsStore: { tags: [] } }),
}));

jest.mock('../QuickCaptureInput', () => ({
    __esModule: true,
    default: function MockQuickCaptureInput() {
        return <div data-testid="composer" />;
    },
}));

const noop = () => {};

const renderItem = (content: string, onUpdate = jest.fn()) =>
    render(
        <InboxItemDetail
            item={{ uid: 'abc123', content, title: null }}
            onDelete={noop}
            onUpdate={onUpdate}
            openTaskModal={noop}
            openProjectModal={noop}
            openNoteModal={noop}
            projects={[]}
        />
    );

describe('InboxItemDetail - ~area chips in the preview', () => {
    it('shows a ~area token as a removable chip', () => {
        renderItem('Plan offsite ~Work soon');

        const remove = screen.getByRole('button', {
            name: 'Remove area Work',
        });
        expect(remove.parentElement).toHaveTextContent('~Work');
    });

    it('shows a quoted area name without its quotes', () => {
        renderItem('Plan ~"Home Office" trip');

        const remove = screen.getByRole('button', {
            name: 'Remove area Home Office',
        });
        expect(remove.parentElement).toHaveTextContent('~Home Office');
    });

    it('does not read a ~ inside a word as an area', () => {
        renderItem('Rename draft~v2 file');

        expect(
            screen.queryByRole('button', { name: /^Remove area/ })
        ).not.toBeInTheDocument();
        expect(screen.getByText('Rename draft~v2 file')).toBeInTheDocument();
    });

    it('removes the area token from the text without opening the editor', () => {
        const onUpdate = jest.fn();
        renderItem('Plan offsite ~Work soon', onUpdate);

        fireEvent.click(
            screen.getByRole('button', { name: 'Remove area Work' })
        );

        expect(onUpdate).toHaveBeenCalledWith('abc123', 'Plan offsite soon');
        expect(screen.queryByTestId('composer')).not.toBeInTheDocument();
    });
});
